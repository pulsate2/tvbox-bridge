#!/usr/bin/env bash
# 从 xiugou-tv 源码构建 companion-service.jar（复刻其 companion/build.ps1 的关键步骤）。
# 产物：companion/dist/companion-service.jar + bcprov + lib-unidbg/
#
# 需要：bash、JDK 17+（javac / jar / java）。
# 源码目录可用 COMPANION_SRC_DIR 覆盖（默认 ../xiugou-tv）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
XIUGOU="$(cd "${COMPANION_SRC_DIR:-$ROOT/../xiugou-tv}" && pwd)"
LIB_DIR="$XIUGOU/companion/lib"
LIBS_DIR="$XIUGOU/companion/libs"
UNIDBG_DIR="$XIUGOU/companion/lib-unidbg"

BUILD="$ROOT/companion-build/build"
DIST="$ROOT/companion/dist"
CLASSES="$BUILD/classes"
SRC="$BUILD/src"

# 上游把运行时数据目录写死成一个带品牌前缀的隐藏目录（载荷缓存 / prefs / sdcard）。
# 本项目统一改名为 ".tvbox_bridge"，避免在镜像与用户目录里出现上游品牌名。
# 这里不硬编码上游字符串，而是从源码里探测出来再替换（上游改名也能跟上）。
DATA_DIR_NAME=".tvbox_bridge"

# Windows(MSYS/Git Bash) 下 javac/jar 只认反斜杠路径，且 classpath 分隔符是 ';'。
if command -v cygpath >/dev/null 2>&1; then
  to_path() { cygpath -w "$1"; }
  PATHSEP=';'
else
  to_path() { printf '%s' "$1"; }
  PATHSEP=':'
fi

if [ ! -d "$XIUGOU/companion" ]; then
  echo "[build] ERROR: 找不到 xiugou-tv 源码: $XIUGOU" >&2
  echo "[build]        可用 COMPANION_SRC_DIR=/path/to/xiugou-tv 指定" >&2
  exit 1
fi

rm -rf "$BUILD" "$DIST"
mkdir -p "$CLASSES" "$DIST" "$SRC"

CP="$( { ls "$LIB_DIR"/*.jar "$UNIDBG_DIR"/*.jar 2>/dev/null | while read -r f; do to_path "$f"; done; } | tr '\n' "$PATHSEP")"

echo "[build] javac $(javac -version 2>&1)"
echo "[build] 源码: $XIUGOU"

# 先把源码复制到构建目录再编译：需要在副本上做两处改写
#   1) 数据目录名 → .tvbox_bridge
#   2) 用 overlay 版 Drawable 替换上游版本（补 ConstantState）
(
  cd "$XIUGOU"
  find android-bridge/src companion/src -name '*.java' \
    ! -path 'android-bridge/src/android/graphics/drawable/Drawable.java' \
    | while read -r f; do
        mkdir -p "$SRC/$(dirname "$f")"
        cp "$f" "$SRC/$f"
      done
)
mkdir -p "$SRC/overlay"
cp -r "$ROOT/companion-build/overlay/." "$SRC/overlay/"

UPSTREAM_DATA_DIR="$(grep -rhoE '"\.[A-Za-z0-9_]*_tv_companion"' "$SRC" 2>/dev/null | head -1 | tr -d '"' || true)"
if [ -n "$UPSTREAM_DATA_DIR" ] && [ "$UPSTREAM_DATA_DIR" != "$DATA_DIR_NAME" ]; then
  echo "[build] 改写数据目录: $UPSTREAM_DATA_DIR -> $DATA_DIR_NAME"
  grep -rl "$UPSTREAM_DATA_DIR" "$SRC" 2>/dev/null | while read -r f; do
    sed -i "s/$UPSTREAM_DATA_DIR/$DATA_DIR_NAME/g" "$f"
  done
else
  echo "[build] WARN: 未在源码中探测到上游数据目录字面量，跳过改名"
fi

find "$SRC" -name '*.java' | while read -r f; do to_path "$f"; done > "$BUILD/sources.txt"
javac -encoding UTF-8 -cp "$CP" -d "$(to_path "$CLASSES")" @"$(to_path "$BUILD/sources.txt")"

# 合并依赖到 classes（保持单 jar 自包含）；android-json 必须压过 json-20231013 的 org.json
echo "[build] merge dependencies"
mkdir -p "$BUILD/deps"
for jar in "$LIB_DIR"/*.jar; do
  name="$(basename "$jar" .jar)"
  mkdir -p "$BUILD/deps/$name"
  ( cd "$BUILD/deps/$name" && jar xf "$(to_path "$jar")" )
  if [[ "$name" == json-2* ]]; then
    rm -rf "$BUILD/deps/$name/org"
  fi
  cp -r "$BUILD/deps/$name/." "$CLASSES/"
  if [ -d "$BUILD/deps/$name/META-INF/services" ]; then
    mkdir -p "$CLASSES/META-INF/services"
    for f in "$BUILD/deps/$name/META-INF/services"/*; do
      [ -f "$f" ] || continue
      cat "$f" >> "$CLASSES/META-INF/services/$(basename "$f")" || true
      echo >> "$CLASSES/META-INF/services/$(basename "$f")" || true
    done
  fi
done
# 去重 services
for f in "$CLASSES/META-INF/services"/*; do
  [ -f "$f" ] || continue
  awk 'NF && !seen[$0]++' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

# 依赖里带 Java 21 的 module-info（major 65），JDK17 的 jar 工具打包会拒绝；
# classpath 模式不需要 module 描述符，直接删掉。
find "$CLASSES" -name 'module-info.class' -delete

# okhttp 调试日志字节码注入（可选；失败不阻塞构建）
if [ -f "$CLASSES/okhttp3/OkHttpClient\$Builder.class" ]; then
  java -cp "$(to_path "$CLASSES")$PATHSEP$CP" com.fongmi.companion.agent.PatchOkHttp \
    "$(to_path "$CLASSES/okhttp3/OkHttpClient\$Builder.class")" \
    || echo "[build] WARN: PatchOkHttp failed"
fi

cat > "$BUILD/MANIFEST.MF" <<'EOF'
Manifest-Version: 1.0
Main-Class: com.fongmi.companion.Main
Premain-Class: com.fongmi.companion.agent.HttpLogAgent
Agent-Class: com.fongmi.companion.agent.HttpLogAgent
Can-Retransform-Classes: true

EOF

( cd "$CLASSES" && jar cfm "$(to_path "$DIST/companion-service.jar")" "$(to_path "$BUILD/MANIFEST.MF")" . )

# 运行时依赖：bcprov 独立 jar（签名不能破坏）
cp "$LIBS_DIR"/*.jar "$DIST/" 2>/dev/null || true
# 加固壳解密依赖：与 jar 同级
mkdir -p "$DIST/lib-unidbg"
cp "$UNIDBG_DIR"/*.jar "$DIST/lib-unidbg/"
# AndroidBridge 也会在 jar 同目录 / libs 下找 bcprov；复制一份进 libs 以覆盖相对路径候选
mkdir -p "$DIST/libs"
cp "$LIBS_DIR"/*.jar "$DIST/libs/" 2>/dev/null || true

echo "[build] done: $DIST/companion-service.jar"
ls -lh "$DIST/companion-service.jar" "$DIST"/*.jar | head