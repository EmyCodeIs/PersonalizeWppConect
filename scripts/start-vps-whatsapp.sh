#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export DISPLAY="${SESSION_DISPLAY:-:1}"

bash "$ROOT_DIR/scripts/start-session-access.sh"

cd "$ROOT_DIR"

echo "[vps] iniciando WPPConnect dentro do desktop compartilhado $DISPLAY"
echo "[vps] o vendedor verá e controlará exatamente o Chrome aberto pelo bot"
echo

exec npm start
