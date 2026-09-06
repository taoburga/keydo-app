#!/usr/bin/env bash
# Compile the Swift daemon. Run from project root or anywhere.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../bin/reminders-daemon"
mkdir -p "$(dirname "$OUT")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: swiftc not found. Install Xcode command line tools: xcode-select --install" >&2
  exit 1
fi

echo "Compiling reminders-daemon..."
swiftc -O "$HERE/Reminders.swift" -framework EventKit -o "$OUT"
echo "Built: $OUT"
ls -la "$OUT"
