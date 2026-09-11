#!/bin/sh
# Compile the native modules the image needs, OUTSIDE BuildKit, and place the
# binaries under ./compiled so docker/images/n8n/Dockerfile only stages them.
#
# Why: on the Aon host BuildKit's RUN sandbox SIGKILLs isolated-vm's compile at
# ~18 s whatever -j it is given, while the same compile in a plain container
# finishes. Run after `pnpm build:n8n` and before `docker build`.
#
# Usage: scripts/aon-build-native.sh [builder-image]
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${1:-node:26.7.0-alpine3.24}"
P="$ROOT/compiled/node_modules/.pnpm"
GYP=/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js
TMP="$(mktemp -d /tmp/aon-native.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

IVM="$(ls -d "$P"/isolated-vm@*/node_modules/isolated-vm | head -1)"
KAF="$(ls -d "$P"/@confluentinc+kafka-javascript@*/node_modules/@confluentinc/kafka-javascript | head -1)"
NAN="$(ls -d "$P"/@confluentinc+kafka-javascript@*/node_modules/nan | head -1)"

# A cache beside the tree: the binaries only change when the package versions
# do, and `pnpm build:n8n` recreates ./compiled every time.
CACHE="${AON_NATIVE_CACHE:-/root/aon-n8n-native}"
if [ -f "$CACHE/isolated_vm.node" ] && [ -f "$CACHE/confluent-kafka-javascript.node" ]; then
  echo "== reusing cached binaries from $CACHE"
  mkdir -p "$IVM/build/Release" "$KAF/build/Release"
  cp "$CACHE/isolated_vm.node" "$IVM/build/Release/" && rm -rf "$IVM/prebuilds"
  cp "$CACHE/confluent-kafka-javascript.node" "$KAF/build/Release/"
  ls -l "$IVM/build/Release/isolated_vm.node" "$KAF/build/Release/confluent-kafka-javascript.node"
  exit 0
fi

echo "== isolated-vm"
cp -rL "$IVM" "$TMP/isolated-vm"
docker run --rm --memory 12g --memory-swap 12g -v "$TMP/isolated-vm:/build" -w /build "$IMG" sh -c \
  "apk add --no-cache python3 make g++ >/dev/null && rm -rf prebuilds build && node $GYP rebuild --release -j 2 >/dev/null && ls -l build/Release/isolated_vm.node"
mkdir -p "$IVM/build/Release" && cp "$TMP/isolated-vm/build/Release/isolated_vm.node" "$IVM/build/Release/" && rm -rf "$IVM/prebuilds"

echo "== confluent-kafka-javascript"
mkdir -p "$TMP/kafka/node_modules/@confluentinc"
cp -rL "$KAF" "$TMP/kafka/node_modules/@confluentinc/kafka-javascript"
cp -rL "$NAN" "$TMP/kafka/node_modules/nan"
docker run --rm --memory 12g --memory-swap 12g -v "$TMP/kafka:/build" -w /build/node_modules/@confluentinc/kafka-javascript "$IMG" sh -c \
  "apk add --no-cache python3 make g++ librdkafka-dev >/dev/null && BUILD_LIBRDKAFKA=0 node $GYP rebuild --release -j 2 >/dev/null && ls -l build/Release/confluent-kafka-javascript.node"
mkdir -p "$KAF/build/Release" && cp "$TMP/kafka/node_modules/@confluentinc/kafka-javascript/build/Release/confluent-kafka-javascript.node" "$KAF/build/Release/"

mkdir -p "$CACHE" && cp "$IVM/build/Release/isolated_vm.node" "$KAF/build/Release/confluent-kafka-javascript.node" "$CACHE/"
echo "== sqlite3: built by pnpm install on the same image; nothing to do"
ls -l "$(ls -d "$P"/sqlite3@*/node_modules/sqlite3 | head -1)/build/Release/node_sqlite3.node"
echo "done"
