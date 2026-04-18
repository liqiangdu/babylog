#!/usr/bin/env bash
# Babylog dev launcher for macOS / Linux.
#
# Usage:
#   ./start.sh                # run frontend + backend in this terminal
#   FRONTEND_PORT=3000 ./start.sh
#   BACKEND_PORT=8787 ./start.sh
#
# Both services are started as children of this script; Ctrl-C stops both.
# Frontend: `npm run dev` (Vite + TypeScript) when package.json exists; requires Node.js.
# Backend:  `cargo run` in ./backend.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-8787}"

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "Backend directory not found: $BACKEND_DIR" >&2
  exit 1
fi

kill_port() {
  local port="$1"
  # lsof is available on macOS out of the box, and on most Linux distros.
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "[boot] stopping process(es) already listening on :$port: $pids"
      # shellcheck disable=SC2086
      kill -TERM $pids 2>/dev/null || true
      sleep 0.5
      # shellcheck disable=SC2086
      kill -KILL $pids 2>/dev/null || true
    fi
  fi
}

kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

# Prefix each service's stdout/stderr so the interleaved output is readable.
prefix_log() {
  local tag="$1"
  # -l line-buffered keeps the prefix attached to each line in real time.
  sed -l -e "s/^/[$tag] /"
}

FRONTEND_PIDFILE="$(mktemp)"
BACKEND_PIDFILE="$(mktemp)"

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "[boot] shutting down…"
  for pf in "$FRONTEND_PIDFILE" "$BACKEND_PIDFILE"; do
    if [[ -s "$pf" ]]; then
      local pid
      pid="$(cat "$pf")"
      if kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
      fi
    fi
  done
  # Give children a moment, then force-kill anything still holding the ports.
  sleep 0.5
  kill_port "$BACKEND_PORT"
  kill_port "$FRONTEND_PORT"
  rm -f "$FRONTEND_PIDFILE" "$BACKEND_PIDFILE"
}
trap cleanup INT TERM EXIT

# --- frontend ---
(
  cd "$SCRIPT_DIR"
  if [[ -f package.json ]] && command -v npm >/dev/null 2>&1; then
    if [[ ! -d node_modules ]]; then
      echo "[frontend] running npm install (first time)…"
      npm install
    fi
    exec npm run dev -- --port "$FRONTEND_PORT"
  else
    echo "[frontend] This tree needs Node.js + npm (see package.json). Install Node, then: npm install && npm run dev" >&2
    exit 1
  fi
) 2>&1 | prefix_log "frontend" &
echo "$!" > "$FRONTEND_PIDFILE"

# --- backend ---
(
  cd "$BACKEND_DIR"
  exec cargo run
) 2>&1 | prefix_log "backend" &
echo "$!" > "$BACKEND_PIDFILE"

echo "[boot] frontend -> http://localhost:$FRONTEND_PORT"
echo "[boot] backend  -> http://localhost:$BACKEND_PORT"
echo "[boot] press Ctrl-C to stop both."

wait
