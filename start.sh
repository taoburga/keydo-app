#!/usr/bin/env bash
# Launch the todo-app local server.
set -e
cd "$(dirname "$0")"

# Build the Swift daemon if missing or stale.
DAEMON=bin/reminders-daemon
SRC=daemon/Reminders.swift
if [[ ! -x "$DAEMON" || "$SRC" -nt "$DAEMON" ]]; then
  echo "Building $DAEMON..."
  bash daemon/build.sh
fi

PORT="${PORT:-4321}"
URL="http://127.0.0.1:$PORT"

# Open browser shortly after server starts (in background).
( sleep 1 && open "$URL" ) &

PORT="$PORT" exec node server.js
