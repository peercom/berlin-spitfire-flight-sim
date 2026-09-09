#!/bin/zsh
set -e

SIM_DIR="${0:A:h}"
SIM_PORT=4173

if lsof -nP -iTCP:${SIM_PORT} -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${SIM_PORT} is already in use. Close the other local server and try again."
  read -k 1 "?Press any key to close…"
  exit 1
fi

cd "$SIM_DIR"
python3 -m http.server "$SIM_PORT" --bind 127.0.0.1 --directory dist &
SIM_SERVER_PID=$!
trap 'kill "$SIM_SERVER_PID" 2>/dev/null || true' EXIT INT TERM

open "http://127.0.0.1:${SIM_PORT}/"
echo "Spitfire IX is running at http://127.0.0.1:${SIM_PORT}/"
echo "Keep this window open while flying. Press Control-C to stop."
wait "$SIM_SERVER_PID"
