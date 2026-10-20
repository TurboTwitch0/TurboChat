#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3001}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
LOG_FILE="${ORBIT_START_LOG:-/tmp/orbit-chat.log}"
if curl --fail --silent "$HEALTH_URL" >/dev/null; then
  echo "Orbit is already running on port ${PORT}."
  exit 0
fi
cd "$APP_DIR"
nohup env PORT="$PORT" ORBIT_START_LOG="$LOG_FILE" bash "$APP_DIR/scripts/keep-running.sh" >"$LOG_FILE" 2>&1 </dev/null &
for _ in $(seq 1 30); do
  if curl --fail --silent "$HEALTH_URL" >/dev/null; then
    echo "Orbit started on port ${PORT}."
    exit 0
  fi
  sleep 1
done
echo "Orbit did not start. Recent server output:" >&2
tail -n 40 "$LOG_FILE" >&2
exit 1
