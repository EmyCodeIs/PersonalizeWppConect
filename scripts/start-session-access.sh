#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
DATA_DIR="$ROOT_DIR/data"
PID_DIR="$DATA_DIR/session-access"
mkdir -p "$DATA_DIR" "$PID_DIR"

# Carrega o .env sem executar espaços, ponto e vírgula ou & como comandos shell.
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$ENV_FILE"

DISPLAY_VALUE="${SESSION_DISPLAY:-:1}"
SCREEN_SIZE="${SESSION_SCREEN_SIZE:-1366x768x24}"
SESSION_ACCESS_HOST="${SESSION_ACCESS_HOST:-127.0.0.1}"
SESSION_ACCESS_PORT="${SESSION_ACCESS_PORT:-6080}"
SESSION_VNC_PORT="${SESSION_VNC_PORT:-5901}"
SESSION_ACCESS_PASSWORD="${SESSION_ACCESS_PASSWORD:-troque-esta-senha}"
SESSION_NOVNC_WEB="${SESSION_NOVNC_WEB:-/usr/share/novnc}"
SESSION_VNC_PASSWORD_FILE="${SESSION_VNC_PASSWORD_FILE:-$DATA_DIR/session-access.vncpass}"
SESSION_ACCESS_PUBLIC_URL="${SESSION_ACCESS_PUBLIC_URL:-}"

XVFB_PID_FILE="$PID_DIR/xvfb.pid"
OPENBOX_PID_FILE="$PID_DIR/openbox.pid"
X11VNC_PID_FILE="$PID_DIR/x11vnc.pid"
NOVNC_PID_FILE="$PID_DIR/novnc.pid"

XVFB_LOG="$DATA_DIR/xvfb.log"
OPENBOX_LOG="$DATA_DIR/openbox.log"
X11VNC_LOG="$DATA_DIR/x11vnc.log"
NOVNC_LOG="$DATA_DIR/novnc.log"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[session-access] comando obrigatório não encontrado: $1" >&2
    exit 1
  fi
}

pid_is_running() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

cleanup_stale_pid() {
  local file="$1"
  if [[ -f "$file" ]] && ! pid_is_running "$file"; then
    rm -f "$file"
  fi
}

need_cmd Xvfb
need_cmd openbox-session
need_cmd x11vnc
need_cmd bash

if [[ ! -d "$SESSION_NOVNC_WEB" ]]; then
  echo "[session-access] diretório do noVNC não encontrado: $SESSION_NOVNC_WEB" >&2
  echo "[session-access] execute npm run session:access:install:ubuntu" >&2
  exit 1
fi

if [[ "$SESSION_ACCESS_PASSWORD" == "troque-esta-senha" ]]; then
  echo "[session-access] defina uma senha forte em SESSION_ACCESS_PASSWORD no .env" >&2
  exit 1
fi

for file in "$XVFB_PID_FILE" "$OPENBOX_PID_FILE" "$X11VNC_PID_FILE" "$NOVNC_PID_FILE"; do
  cleanup_stale_pid "$file"
done

if ! pid_is_running "$XVFB_PID_FILE"; then
  nohup Xvfb "$DISPLAY_VALUE" \
    -screen 0 "$SCREEN_SIZE" \
    -ac \
    -nolisten tcp \
    -noreset \
    >"$XVFB_LOG" 2>&1 &
  echo $! > "$XVFB_PID_FILE"
  sleep 1
  echo "[session-access] desktop virtual iniciado em $DISPLAY_VALUE"
else
  echo "[session-access] desktop virtual já está ativo"
fi

if ! pid_is_running "$OPENBOX_PID_FILE"; then
  DISPLAY="$DISPLAY_VALUE" nohup openbox-session >"$OPENBOX_LOG" 2>&1 &
  echo $! > "$OPENBOX_PID_FILE"
  sleep 1
  echo "[session-access] gerenciador de janelas iniciado"
else
  echo "[session-access] gerenciador de janelas já está ativo"
fi

if ! x11vnc -storepasswd "$SESSION_ACCESS_PASSWORD" "$SESSION_VNC_PASSWORD_FILE" >/dev/null 2>&1; then
  echo "[session-access] não foi possível gravar a senha VNC" >&2
  exit 1
fi

if ! pid_is_running "$X11VNC_PID_FILE"; then
  nohup x11vnc \
    -display "$DISPLAY_VALUE" \
    -rfbport "$SESSION_VNC_PORT" \
    -rfbauth "$SESSION_VNC_PASSWORD_FILE" \
    -localhost \
    -forever \
    -shared \
    -noxdamage \
    -repeat \
    >"$X11VNC_LOG" 2>&1 &
  echo $! > "$X11VNC_PID_FILE"
  sleep 1
  echo "[session-access] compartilhamento da tela iniciado"
else
  echo "[session-access] compartilhamento da tela já está ativo"
fi

if command -v novnc_proxy >/dev/null 2>&1; then
  NOVNC_CMD=(novnc_proxy --listen "${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}" --vnc "127.0.0.1:${SESSION_VNC_PORT}" --web "$SESSION_NOVNC_WEB")
elif [[ -x "$SESSION_NOVNC_WEB/utils/novnc_proxy" ]]; then
  NOVNC_CMD=("$SESSION_NOVNC_WEB/utils/novnc_proxy" --listen "${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}" --vnc "127.0.0.1:${SESSION_VNC_PORT}" --web "$SESSION_NOVNC_WEB")
elif command -v websockify >/dev/null 2>&1; then
  NOVNC_CMD=(websockify --web "$SESSION_NOVNC_WEB" "${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}" "127.0.0.1:${SESSION_VNC_PORT}")
else
  echo "[session-access] novnc_proxy/websockify não encontrado" >&2
  exit 1
fi

if ! pid_is_running "$NOVNC_PID_FILE"; then
  nohup "${NOVNC_CMD[@]}" >"$NOVNC_LOG" 2>&1 &
  echo $! > "$NOVNC_PID_FILE"
  sleep 1
  echo "[session-access] acesso pelo navegador iniciado"
else
  echo "[session-access] acesso pelo navegador já está ativo"
fi

DEFAULT_URL="http://${SESSION_ACCESS_HOST}:${SESSION_ACCESS_PORT}/vnc.html?autoconnect=true&resize=scale"
ACCESS_URL="${SESSION_ACCESS_PUBLIC_URL:-$DEFAULT_URL}"

echo
echo "[session-access] pronto"
echo "[session-access] desktop compartilhado: $DISPLAY_VALUE"
echo "[session-access] link do vendedor: $ACCESS_URL"
echo "[session-access] o Chrome iniciado com DISPLAY=$DISPLAY_VALUE aparecerá nesse link"
echo
