#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ ! -f "$REAL_ENV_FILE" ]]; then
  echo "[preflight-admin] FALHA: arquivo .env ausente em $REAL_ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$REAL_ENV_FILE"

is_true() {
  case "${1,,}" in
    1|true|yes|sim|on) return 0 ;;
    *) return 1 ;;
  esac
}

if is_true "${ENABLE_TEST_COMMANDS:-false}"; then
  if [[ -z "${TEST_COMMAND_ALLOWED_CLIENT_NUMBERS:-}" && -z "${TEST_COMMAND_ALLOWED_CHAT_IDS:-}" ]]; then
    echo "[preflight-admin] FALHA: comandos administrativos ativos sem administrador configurado" >&2
    exit 1
  fi
  echo "[preflight-admin] OK: comandos ativos somente com whitelist administrativa separada"
else
  echo "[preflight-admin] OK: comandos administrativos desativados"
fi

if [[ -n "${ALLOWED_CLIENT_NUMBERS:-}" || -n "${ALLOWED_CHAT_IDS:-}" ]]; then
  echo "[preflight-admin] FALHA: whitelist geral preenchida; o bot não atenderia todos os contatos" >&2
  exit 1
fi

echo "[preflight-admin] OK: atendimento geral liberado"

# O preflight legado exige comandos desativados. Cria uma cópia temporária do
# ambiente somente para essa verificação, sem alterar o .env real nem imprimir
# seus valores. Todas as demais verificações continuam sendo executadas.
TEMP_ENV="$(mktemp)"
chmod 600 "$TEMP_ENV"
trap 'rm -f "$TEMP_ENV"' EXIT

awk '
  BEGIN { replaced = 0 }
  /^ENABLE_TEST_COMMANDS=/ {
    print "ENABLE_TEST_COMMANDS=false"
    replaced = 1
    next
  }
  { print }
  END {
    if (!replaced) print "ENABLE_TEST_COMMANDS=false"
  }
' "$REAL_ENV_FILE" > "$TEMP_ENV"

ENV_FILE="$TEMP_ENV" bash "$ROOT_DIR/scripts/vps-preflight.sh"
