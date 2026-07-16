#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SQLITE_SNAPSHOT="$ROOT_DIR/data/personalize-backup.sqlite"

# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dotenv.sh"
load_dotenv_file "$ENV_FILE"

BACKUP_DIR="${VPS_BACKUP_DIR:-$HOME/personalize-backups}"
RETENTION_DAYS="${VPS_BACKUP_RETENTION_DAYS:-14}"
PLAIN_FILE="$BACKUP_DIR/personalize-state-$TIMESTAMP.tar.gz"
ENCRYPTED_FILE="$PLAIN_FILE.enc"

if [[ -z "${VPS_BACKUP_PASSPHRASE:-}" ]]; then
  echo "[backup] VPS_BACKUP_PASSPHRASE ausente" >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "[backup] openssl ausente" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [[ "${STORAGE_DRIVER:-}" == "sqlite" && -f "$ROOT_DIR/${SQLITE_DATABASE_PATH:-data/personalize.sqlite}" ]]; then
  node "$ROOT_DIR/scripts/snapshot-sqlite.js" "$SQLITE_SNAPSHOT"
fi

items=()
[[ -f "$ROOT_DIR/.env" ]] && items+=(.env)
[[ -d "$ROOT_DIR/tokens" ]] && items+=(tokens)
[[ -d "$ROOT_DIR/data" ]] && items+=(data)

if (( ${#items[@]} == 0 )); then
  echo "[backup] nenhum estado encontrado para salvar" >&2
  exit 1
fi

cleanup() {
  rm -f "$PLAIN_FILE" "$SQLITE_SNAPSHOT"
}
trap cleanup EXIT

(
  cd "$ROOT_DIR"
  tar \
    --exclude='data/*.log' \
    --exclude='data/browser-cache' \
    --exclude='data/session-access/*.pid' \
    --exclude='data/session-access/*.lock' \
    --exclude='data/session-access.vncpass' \
    --exclude='data/personalize.sqlite' \
    --exclude='data/personalize.sqlite-wal' \
    --exclude='data/personalize.sqlite-shm' \
    -czf "$PLAIN_FILE" \
    "${items[@]}"
)

openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -in "$PLAIN_FILE" \
  -out "$ENCRYPTED_FILE" \
  -pass env:VPS_BACKUP_PASSPHRASE

chmod 600 "$ENCRYPTED_FILE"

find "$BACKUP_DIR" \
  -maxdepth 1 \
  -type f \
  -name 'personalize-state-*.tar.gz.enc' \
  -mtime "+$RETENTION_DAYS" \
  -delete

echo "[backup] criado e criptografado: $ENCRYPTED_FILE"
echo "[backup] retenção local: $RETENTION_DAYS dia(s)"