#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
PID_DIR="$ROOT_DIR/data/session-access"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$ENV_FILE"

ACCESS_HOST="${SESSION_ACCESS_HOST:-127.0.0.1}"
ACCESS_PORT="${SESSION_ACCESS_PORT:-6080}"
VNC_PORT="${SESSION_VNC_PORT:-5901}"

failures=0

check_pid() {
  local name="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    echo "[health] FALHA $name: arquivo PID ausente"
    failures=$((failures + 1))
    return
  fi

  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "[health] FALHA $name: processo inativo"
    failures=$((failures + 1))
    return
  fi

  echo "[health] OK $name: pid=$pid"
}

check_loopback_listener() {
  local name="$1"
  local port="$2"

  if ! command -v ss >/dev/null 2>&1; then
    echo "[health] AVISO: ss indisponivel; porta $port nao conferida"
    return
  fi

  local listeners
  listeners="$(ss -ltnH "sport = :$port" 2>/dev/null || true)"
  if [[ -z "$listeners" ]]; then
    echo "[health] FALHA $name: porta $port sem listener"
    failures=$((failures + 1))
    return
  fi

  local local_addresses
  local_addresses="$(echo "$listeners" | awk '{print $4}')"
  if echo "$local_addresses" | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]|\*):'; then
    echo "[health] FALHA $name: porta $port exposta em todas as interfaces"
    failures=$((failures + 1))
    return
  fi

  echo "[health] OK $name: porta $port restrita"
}

check_pid "Xvfb" "$PID_DIR/xvfb.pid"
check_pid "Openbox" "$PID_DIR/openbox.pid"
check_pid "x11vnc" "$PID_DIR/x11vnc.pid"
check_pid "proxy web" "$PID_DIR/novnc.pid"

check_loopback_listener "VNC interno" "$VNC_PORT"
check_loopback_listener "acesso web interno" "$ACCESS_PORT"

if command -v curl >/dev/null 2>&1; then
  if curl --fail --silent --show-error --max-time 5 \
    "http://${ACCESS_HOST}:${ACCESS_PORT}/health" >/dev/null; then
    echo "[health] OK acesso web: health acessivel localmente"
  else
    echo "[health] FALHA acesso web: health indisponivel"
    failures=$((failures + 1))
  fi
fi

if (( failures > 0 )); then
  echo "[health] resultado: $failures falha(s)"
  exit 1
fi

echo "[health] resultado: saudavel"