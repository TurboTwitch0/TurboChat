#!/usr/bin/env bash
set -u
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3001}"
LOG_FILE="${ORBIT_START_LOG:-/tmp/orbit-chat.log}"
server_pid=""
stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  exit 0
}
trap stop_server INT TERM
cd "$APP_DIR"
while true; do
  PORT="$PORT" node "$APP_DIR/server.js" >>"$LOG_FILE" 2>&1 &
  server_pid=$!
  wait "$server_pid" || true
  server_pid=""
  printf 'Orbit stopped; restarting in 2 seconds.\n' >>"$LOG_FILE"
  sleep 2
done
