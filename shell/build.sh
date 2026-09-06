#!/bin/bash
# Build the WKWebView shell app and wrap it in a .app bundle.
# Usage: bash shell/build.sh
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

APP_NAME="Todo"
BUILD_DIR="$HERE/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
# Stage into a scratch bundle and swap it in only once the build SUCCEEDS.
# This used to `rm -rf "$APP_BUNDLE"` up front, so any compile failure (a
# missing toolchain, an unaccepted Xcode license, a syntax error) left you with
# no app at all — and no way to relaunch until the build was fixed.
STAGE_BUNDLE="$BUILD_DIR/.$APP_NAME.app.build"
EXEC_DIR="$STAGE_BUNDLE/Contents/MacOS"
RESOURCES_DIR="$STAGE_BUNDLE/Contents/Resources"
EXEC_PATH="$EXEC_DIR/$APP_NAME"

trap 'rm -rf "$STAGE_BUNDLE"' EXIT
rm -rf "$STAGE_BUNDLE"
mkdir -p "$EXEC_DIR" "$RESOURCES_DIR"

SOURCES=$(find Sources -name '*.swift' | sort)
if [[ -z "$SOURCES" ]]; then
  echo "no .swift sources under shell/Sources/" >&2
  exit 1
fi

echo "compiling: $(echo "$SOURCES" | wc -l | tr -d ' ') files (universal: arm64 + x86_64)"
# Build one slice per architecture, then lipo them into a single universal binary
# so the app runs natively on both Apple Silicon and Intel Macs.
ARCH_BINS=()
for arch in arm64 x86_64; do
  arch_out="$EXEC_PATH.$arch"
  swiftc -O \
    -parse-as-library \
    -target "$arch-apple-macos12.0" \
    -framework AppKit -framework WebKit \
    -o "$arch_out" \
    $SOURCES
  ARCH_BINS+=("$arch_out")
done
lipo -create "${ARCH_BINS[@]}" -output "$EXEC_PATH"
rm -f "${ARCH_BINS[@]}"

cp Resources/Info.plist "$STAGE_BUNDLE/Contents/Info.plist"
chmod +x "$EXEC_PATH"

# Ad-hoc codesign avoids "app may be damaged" Gatekeeper warning on locally-built apps.
codesign --force --deep --sign - "$STAGE_BUNDLE" 2>/dev/null || true
xattr -dr com.apple.quarantine "$STAGE_BUNDLE" 2>/dev/null || true

# Everything worked — now, and only now, replace the previous bundle.
rm -rf "$APP_BUNDLE"
mv "$STAGE_BUNDLE" "$APP_BUNDLE"

echo "built: $APP_BUNDLE"
echo "to run: open '$APP_BUNDLE'"
