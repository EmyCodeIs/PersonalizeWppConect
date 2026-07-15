#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$ENV_FILE"

export DISPLAY="${SESSION_DISPLAY:-:1}"

bash "$ROOT_DIR/scripts/start-session-access.sh"

cd "$ROOT_DIR"

echo "[vps] iniciando WPPConnect dentro do desktop compartilhado $DISPLAY"
echo "[vps] o vendedor verá e controlará exatamente o Chrome aberto pelo bot"
echo

# Executa o Node diretamente. Assim PM2/systemd monitora o processo real do bot,
# em vez de acompanhar um processo intermediário do npm.
exec node src/start-with-required-labels.js
