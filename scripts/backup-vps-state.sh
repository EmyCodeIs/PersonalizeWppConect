#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${VPS_BACKUP_DIR:-$HOME/personalize-backups}"
RETENTION_DAYS="${VPS_BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="$BACKUP_DIR/personalize-state-$TIMESTAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

items=()
[[ -f "$ROOT_DIR/.env" ]] && items+=(.env)
[[ -d "$ROOT_DIR/tokens" ]] && items+=(tokens)
[[ -d "$ROOT_DIR/data" ]] && items+=(data)

if (( ${#items[@]} == 0 )); then
  echo "[backup] nenhum estado encontrado para salvar" >&2
  exit 1
fi

(
  cd "$ROOT_DIR"
  tar \
    --exclude='data/*.log' \
    --exclude='data/session-access/*.pid' \
    --exclude='data/session-access/*.lock' \
    --exclude='data/session-access.vncpass' \
    -czf "$BACKUP_FILE" \
    "${items[@]}"
)

chmod 600 "$BACKUP_FILE"

find "$BACKUP_DIR" \
  -maxdepth 1 \
  -type f \
  -name 'personalize-state-*.tar.gz' \
  -mtime "+$RETENTION_DAYS" \
  -delete

echo "[backup] criado: $BACKUP_FILE"
echo "[backup] retenção local: $RETENTION_DAYS dia(s)"
echo "[backup] arquivo contém dados sensíveis e está protegido com permissão 600"
