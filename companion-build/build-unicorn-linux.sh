#!/usr/bin/env bash
# Repair the Linux native resource in the distributed Unicorn 1.0.15 jar.
# Keep its Java classes and all other platform resources unchanged.
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || exit 0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNICORN_JAR="${1:-$ROOT/companion/dist/lib-unidbg/unicorn-1.0.15.jar}"
if [[ ! -f "$UNICORN_JAR" ]]; then
  echo "[unicorn] No 1.0.15 jar; skipping its Linux repair"
  exit 0
fi
UNICORN_JAR="$(realpath "$UNICORN_JAR")"

case "$(uname -m)" in
  x86_64) NATIVE_PLATFORM=linux_64 ;;
  aarch64|arm64) NATIVE_PLATFORM=linux_arm64 ;;
  *) echo "[unicorn] Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

for tool in cc cmake make curl tar jar; do
  command -v "$tool" >/dev/null || {
    echo "[unicorn] Missing build tool: $tool (Linux requires a C compiler, CMake, make, curl, tar and JDK)" >&2
    exit 1
  }
done

# This upstream revision implements the JNI interface shipped in 1.0.15.
# Only the link command changes; no Java API downgrade or handwritten CPU shim.
UNICORN_COMMIT=7d0cdc34dfed2de8d63cb87ba857aa28e3676dcf
WORK="$ROOT/companion-build/build/unicorn-linux"
SOURCE="$WORK/source"
CORE_BUILD="$WORK/core"
JNI_BUILD="$WORK/jni"
mkdir -p "$SOURCE"

echo "[unicorn] Rebuilding $NATIVE_PLATFORM from $UNICORN_COMMIT"
curl --fail --location --retry 2 --connect-timeout 20 --max-time 180 \
  --output "$WORK/source.tar.gz" \
  "https://api.github.com/repos/zhkl0228/unicorn/tarball/$UNICORN_COMMIT"
tar -xzf "$WORK/source.tar.gz" --strip-components=1 -C "$SOURCE"

cmake -S "$SOURCE" -B "$CORE_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DUNICORN_BUILD_SHARED=OFF \
  -DUNICORN_ARCH="arm aarch64"
# In this upstream static build, the four ARM archives are separate targets;
# building only "unicorn" does not produce them. Build every archive used by JNI.
cmake --build "$CORE_BUILD" \
  --target unicorn arm-softmmu armeb-softmmu aarch64-softmmu aarch64eb-softmmu \
  --parallel "${UNICORN_BUILD_JOBS:-2}"

cmake -S "$ROOT/companion-build/unicorn" -B "$JNI_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DUNICORN_SOURCE_DIR="$SOURCE" \
  -DUNICORN_BUILD_DIR="$CORE_BUILD"
cmake --build "$JNI_BUILD" --parallel "${UNICORN_BUILD_JOBS:-2}"

RESOURCE="natives/$NATIVE_PLATFORM/libunicorn_java.so"
mkdir -p "$WORK/resources/natives/$NATIVE_PLATFORM"
cp "$JNI_BUILD/libunicorn_java.so" "$WORK/resources/$RESOURCE"
jar --update --file "$UNICORN_JAR" -C "$WORK/resources" "$RESOURCE"
echo "[unicorn] Repaired $RESOURCE in $UNICORN_JAR"
