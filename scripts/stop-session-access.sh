#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT_DIR/data/session-access"

stop_pid() {
  local file="$1"
  local name="$2"

  if [[ ! -f "$file" ]]; then
    echo "[session-access] $name não estava ativo"
    return 0
  fi

  local pid
  pid="$(cat "$file" 2>/dev/null || true)"

  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "[session-access] $name parado"
  else
    echo "[session-access] $name já estava parado"
  fi

  rm -f "$file"
}

stop_pid "$PID_DIR/novnc.pid" "noVNC"
stop_pid "$PID_DIR/x11vnc.pid" "x11vnc"
stop_pid "$PID_DIR/openbox.pid" "Openbox"
stop_pid "$PID_DIR/xvfb.pid" "desktop virtual"
