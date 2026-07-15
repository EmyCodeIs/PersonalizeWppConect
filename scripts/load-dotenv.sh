#!/usr/bin/env bash

load_dotenv_file() {
  local env_file="${1:-}"
  [[ -n "$env_file" && -f "$env_file" ]] || return 0

  if ! command -v node >/dev/null 2>&1; then
    echo "[dotenv] Node.js não encontrado para carregar $env_file" >&2
    return 1
  fi

  while IFS= read -r -d '' entry; do
    export "$entry"
  done < <(
    node - "$env_file" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
const dotenv = require('dotenv');
const parsed = dotenv.parse(fs.readFileSync(path, 'utf8'));

for (const [key, value] of Object.entries(parsed)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  process.stdout.write(`${key}=${String(value)}\0`);
}
NODE
  )
}
