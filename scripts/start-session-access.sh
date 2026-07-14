#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
DATA_DIR="$ROOT_DIR/data"
PID_DIR="$DATA_DIR/session-access"
mkdir -p "$DATA_DIR" "$PID_DIR"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DISPLAY_VALUE="${DISPLAY:-:1}"
SESSION_ACCESS_HOST="${SESSION_ACCESS_HOST:-127.0.0.1}"
SESSION_ACCESS_PORT="${SESSION_ACCESS_PORT:-6080}"
SESSION_VNC_PORT="${SESSION_VNC_PORT:-5901}"
SESSION_ACCESS_PASSWORD="${SESSION_ACCESS_PASSWORD:-2580}"
SESSION_NOVNC_WEB="${SESSION_NOVNC_WEB:-/usr/share/novnc}"
SESSION_VNC_PASSWORD_FILE="${SESSION_VNC_PASSWORD_FILE:-$DATA_DIR/session-access.vncpass}"
X11VNC_LOG="$DATA_DIR/x11vnc.log"
NOVNC_LOG="$DATA_DIR/novnc.log"
X11VNC_PID_FILE="$PID_DIR/x11vnc.pid"
NOVNC_PID_FILE="$PID_DIR/novnc.pid"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[session-access] comando obrigatório não encontrado: $1" >&2
    exit 1
  fi
}

need_cmd x11vnc
need_cmd bash

if [[ ! -d "$SESSION_NOVNC_WEB" ]]; then
  echo "[session-access] diretório do noVNC não encontrado: $SESSION_NOVNC_WEB" >&2
  echo "[session-access] instale o pacote novnc ou ajuste SESSION_NOVNC_WEB no .env" >&2
  exit 1
fi

if ! x11vnc -storepasswd "$SESSION_ACCESS_PASSWORD" "$SESSION_VNC_PASSWORD_FILE" >/dev/null 2>&1; then
  echo "[session-access] não foi possível gravar a senha VNC" >&2
  exit 1
fi

cleanup_pid() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$file"
    fi
  fi
}

cleanup_pid "$X11VNC_PID_FILE"
cleanup_pid "$NOVNC_PID_FILE"

if [[ -f "$X11VNC_PID_FILE" ]]; then
  echo "[session-access] x11vnc já está ativo (pid $(cat "$X11VNC_PID_FILE"))"
else
  x11vnc \
    -display "$DISPLAY_VALUE" \
    -rfbport "$SESSION_VNC_PORT" \
    -rfbauth "$SESSION_VNC_PASSWORD_FILE" \
    -forever \
    -shared \
    -bg \
    -o "$X11VNC_LOG"

  X11VNC_PID="$(pgrep -f "x11vnc .*${SESSION_VNC_PORT}" | head -n 1 || true)"
  if [[ -n "$X11VNC_PID" ]]; then
    echo "$X11VNC_PID" > "$X11VNC_PID_FILE"
  fi
fi

if command -v novnc_proxy >/dev/null 2>&1; then
  NOVNC_CMD=(novnc_proxy --listen "${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}" --vnc "127.0.0.1:${SESSION_VNC_PORT}" --web "$SESSION_NOVNC_WEB")
elif [[ -x "$SESSION_NOVNC_WEB/utils/novnc_proxy" ]]; then
  NOVNC_CMD=("$SESSION_NOVNC_WEB/utils/novnc_proxy" --listen "${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}" --vnc "127.0.0.1:${SESSION_VNC_PORT}" --web "$SESSION_NOVNC_WEB")
elif command -v websockify >/dev/null 2>&1; then
  NOVNC_CMD=(websockify --web "$SESSION_NOVNC_WEB" "${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}" "127.0.0.1:${SESSION_VNC_PORT}")
else
  echo "[session-access] novnc_proxy/websockify não encontrado." >&2
  echo "[session-access] instale o pacote novnc ou websockify." >&2
  exit 1
fi

if [[ -f "$NOVNC_PID_FILE" ]]; then
  echo "[session-access] noVNC já está ativo (pid $(cat "$NOVNC_PID_FILE"))"
else
  nohup "${NOVNC_CMD[@]}" > "$NOVNC_LOG" 2>&1 &
  NOVNC_PID=$!
  echo "$NOVNC_PID" > "$NOVNC_PID_FILE"
fi

echo

echo "[session-access] acesso pronto"
echo "[session-access] display: $DISPLAY_VALUE"
echo "[session-access] VNC interno: $SESSION_VNC_PORT"
echo "[session-access] link: http://${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}/vnc.html"
echo "[session-access] senha: $SESSION_ACCESS_PASSWORD"
echo