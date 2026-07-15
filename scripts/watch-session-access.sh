#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$ENV_FILE"

INTERVAL_SECONDS="${SESSION_ACCESS_WATCH_INTERVAL_SECONDS:-30}"
INTERVAL_SECONDS="$(( INTERVAL_SECONDS < 10 ? 10 : INTERVAL_SECONDS ))"

stop_requested=false
trap 'stop_requested=true' SIGINT SIGTERM

echo "[watchdog] supervisão do acesso remoto iniciada; intervalo=${INTERVAL_SECONDS}s"

while [[ "$stop_requested" == "false" ]]; do
  if ! bash "$ROOT_DIR/scripts/session-access-health.sh" >/dev/null 2>&1; then
    echo "[watchdog] componente inativo detectado; tentando recuperar"
    if bash "$ROOT_DIR/scripts/start-session-access.sh"; then
      echo "[watchdog] recuperação concluída"
    else
      echo "[watchdog] recuperação falhou; nova tentativa em ${INTERVAL_SECONDS}s" >&2
    fi
  fi

  sleep "$INTERVAL_SECONDS" &
  wait $! || true
done

echo "[watchdog] supervisão encerrada"
