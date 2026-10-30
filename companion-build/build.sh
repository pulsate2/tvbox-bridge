#!/usr/bin/env bash
# 从 Java 解析层源码构建 companion-service.jar（CatVod spider 运行时）。
# 产物：companion/dist/companion-service.jar + bcprov + lib-unidbg/
#
# 需要：bash、JDK 17+（javac / jar / java）。
# 源码目录由 COMPANION_SRC_DIR 指定，默认 ../companion-src。
# 源码树需包含 android-bridge/src 与 companion/src 两个模块。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPANION_SRC="$(cd "${COMPANION_SRC_DIR:-$ROOT/../companion-src}" && pwd)"
LIB_DIR="$COMPANION_SRC/companion/lib"
LIBS_DIR="$COMPANION_SRC/companion/libs"
UNIDBG_DIR="$COMPANION_SRC/companion/lib-unidbg"

BUILD="$ROOT/companion-build/build"
DIST="$ROOT/companion/dist"
CLASSES="$BUILD/classes"
SRC="$BUILD/src"

# 上游把运行时数据目录写死成一个带品牌前缀的隐藏目录（载荷缓存 / prefs / sdcard）。
# 本项目统一改名为 ".tvbox_bridge"，避免在镜像与用户目录里出现上游品牌名。
# 这里不硬编码上游字符串，而是从源码里探测出来再替换（上游改名也能跟上）。
DATA_DIR_NAME=".tvbox_bridge"

# Windows(MSYS/Git Bash) 下 javac/jar 只认反斜杠路径，且 classpath 分隔符是 ';'。
# to_path 统一输出「一行一个路径」（末尾带换行）：
#   - 拼 @argfile 时必须一行一个，否则所有源码路径会连成一行（CI 上就踩过这个坑）；
#   - 用在 "$(to_path ...)" 里时，命令替换会自动去掉尾部换行，不影响单路径场景。
if command -v cygpath >/dev/null 2>&1; then
  to_path() { cygpath -w "$1"; }
  PATHSEP=';'
else
  to_path() { printf '%s\n' "$1"; }
  PATHSEP=':'
fi

if [ ! -d "$COMPANION_SRC/companion" ] || [ ! -d "$COMPANION_SRC/android-bridge" ]; then
  echo "[build] ERROR: 解析层源码目录无效: $COMPANION_SRC" >&2
  echo "[build]        需要包含 android-bridge/src 与 companion/src 两个模块" >&2
  echo "[build]        用 COMPANION_SRC_DIR=/path/to/source 指定" >&2
  exit 1
fi

rm -rf "$BUILD" "$DIST"
mkdir -p "$CLASSES" "$DIST" "$SRC"

CP="$( { ls "$LIB_DIR"/*.jar "$UNIDBG_DIR"/*.jar 2>/dev/null | while read -r f; do to_path "$f"; done; } | tr '\n' "$PATHSEP")"

echo "[build] javac $(javac -version 2>&1)"
echo "[build] 源码: $COMPANION_SRC"

# 先把源码复制到构建目录，再在副本上做改写。
# 注意：**不要整类替换上游文件**。上游会持续演进（例如 Drawable 后来自己补了
# getConstantState 和 getBounds），整类替换会让子类的 @Override 全部失效，
# CI 上就因此编译失败过。这里只「缺什么补什么」。
(
  cd "$COMPANION_SRC"
  find android-bridge/src companion/src -name '*.java' -print0 \
    | while IFS= read -r -d '' f; do
        mkdir -p "$SRC/$(dirname "$f")"
        cp "$f" "$SRC/$f"
      done
)

# 补丁 1：android.widget.ListAdapter —— 饭太硬载荷的 Pan 初始化时引用，上游没有。
LIST_ADAPTER="$SRC/android-bridge/src/android/widget/ListAdapter.java"
if [ ! -f "$LIST_ADAPTER" ]; then
  mkdir -p "$(dirname "$LIST_ADAPTER")"
  cp "$ROOT/companion-build/overlay/android/widget/ListAdapter.java" "$LIST_ADAPTER"
  echo "[build] 补丁: android.widget.ListAdapter（上游缺失）"
else
  echo "[build] 上游已提供 ListAdapter，跳过补丁"
fi

# 补丁 2：Drawable.getConstantState() / Drawable$ConstantState —— 载荷的 ProxyOrigin
# 在 playerContent 路径上会调用 getConstantState().newDrawable()。上游新版本已自带，
# 老版本没有；这里检测后按需注入（只追加成员，不动既有实现）。
DRAWABLE="$SRC/android-bridge/src/android/graphics/drawable/Drawable.java"
if [ ! -f "$DRAWABLE" ]; then
  echo "[build] WARN: 未找到 $DRAWABLE，跳过 ConstantState 补丁"
elif grep -q 'getConstantState' "$DRAWABLE"; then
  echo "[build] 上游已提供 Drawable.getConstantState，跳过补丁"
else
  echo "[build] 补丁: Drawable.getConstantState（上游缺失）"
  awk '
    { line[NR] = $0 }
    END {
      last = 0
      for (i = NR; i >= 1; i--) if (line[i] ~ /^[[:space:]]*}[[:space:]]*$/) { last = i; break }
      if (last == 0) { for (i = 1; i <= NR; i++) print line[i]; exit }
      for (i = 1; i <= NR; i++) {
        if (i == last) {
          print "    public ConstantState getConstantState() {"
          print "        final Drawable self = this;"
          print "        return new ConstantState() {"
          print "            @Override public Drawable newDrawable() { return self; }"
          print "        };"
          print "    }"
          print ""
          print "    public abstract static class ConstantState {"
          print "        public abstract Drawable newDrawable();"
          print "        public int getChangingConfigurations() { return 0; }"
          print "    }"
        }
        print line[i]
      }
    }
  ' "$DRAWABLE" > "$DRAWABLE.tmp" && mv "$DRAWABLE.tmp" "$DRAWABLE"
  grep -q 'class ConstantState' "$DRAWABLE" || { echo "[build] ERROR: ConstantState 注入失败" >&2; exit 1; }
fi

# ----------------------------------------------------------------------
# 品牌串改写：上游把项目名写死进了数据目录、缓存目录、系统属性与调试开关，
# 这些字符串会随 class 一起打进 jar（镜像里可见）。这里统一换成 tvbox_bridge。
#
# 品牌名不硬编码：从「数据目录字面量」反推（`".<brand>_tv_companion"`），
# 因此上游改名也能自动跟上，本仓库里也不会出现上游品牌字样。
# ----------------------------------------------------------------------
UPSTREAM_DATA_DIR="$(grep -rhoE '"\.[A-Za-z0-9_]+_tv_companion"' "$SRC" 2>/dev/null | head -1 | tr -d '"' || true)"
BRAND=""
if [ -n "$UPSTREAM_DATA_DIR" ]; then
  BRAND="${UPSTREAM_DATA_DIR#.}"
  BRAND="${BRAND%_tv_companion}"
fi

if [ -n "$BRAND" ]; then
  BRAND_UPPER="$(printf '%s' "$BRAND" | tr '[:lower:]' '[:upper:]')"
  BRAND_CAP="$(printf '%s' "$BRAND" | awk '{ print toupper(substr($0,1,1)) substr($0,2) }')"
  echo "[build] 品牌串改写: $BRAND -> tvbox_bridge"

  # 逐条替换（顺序敏感：先处理带下划线/连字符的长串，再处理点号命名空间）
  rewrite() {
    local pattern="$1" replacement="$2"
    grep -rl -- "$pattern" "$SRC" 2>/dev/null | while IFS= read -r f; do
      sed -i "s|$pattern|$replacement|g" "$f"
    done
  }
  rewrite "\.${BRAND}_tv_companion" ".${DATA_DIR_NAME}"
  rewrite "${BRAND}_tv_\([a-z]*\)" "tvbox_bridge_\1"
  rewrite "${BRAND}-tv" "tvbox-bridge"
  rewrite "${BRAND_CAP}" "TvboxBridge"
  rewrite "${BRAND_UPPER}_DEBUG" "TVBOX_BRIDGE_DEBUG"
  rewrite "${BRAND}\." "tvbox.bridge."

  # 兜底校验：任何残留都会被打进镜像，直接失败而不是静默放过
  LEFTOVER="$(grep -rIoi "$BRAND" "$SRC" 2>/dev/null | head -5 || true)"
  if [ -n "$LEFTOVER" ]; then
    echo "[build] ERROR: 仍有未改写的品牌串，请补充 build.sh 的 rewrite 规则：" >&2
    grep -rIn -i "$BRAND" "$SRC" 2>/dev/null | head -10 >&2
    exit 1
  fi
else
  echo "[build] WARN: 未探测到上游数据目录字面量，跳过品牌串改写"
fi

# @argfile 必须「一行一个路径」。这里额外校验一遍：路径被连成一行时 javac 只会报
# "file not found: <超长拼接串>"，在 CI 日志里几乎无法定位。
# 判据：行数不能少得离谱（本仓库当前 121 个），且每行都必须以 .java 结尾。
: > "$BUILD/sources.txt"
find "$SRC" -name '*.java' -print0 | while IFS= read -r -d '' f; do to_path "$f" >> "$BUILD/sources.txt"; done
SOURCE_COUNT="$(wc -l < "$BUILD/sources.txt" | tr -d ' ')"
BAD_LINES="$(grep -cv '\.java$' "$BUILD/sources.txt" || true)"
if [ "$SOURCE_COUNT" -lt 50 ] || [ "$BAD_LINES" -ne 0 ]; then
  echo "[build] ERROR: 源码清单异常（$SOURCE_COUNT 行，$BAD_LINES 行不是以 .java 结尾）" >&2
  echo "[build]        前 3 行：$(head -3 "$BUILD/sources.txt" | cut -c1-200)" >&2
  exit 1
fi
echo "[build] 源码文件: $SOURCE_COUNT"
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