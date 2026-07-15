#!/usr/bin/env bash

load_dotenv_file() {
  local env_file="${1:-}"
  [[ -n "$env_file" && -f "$env_file" ]] || return 0

  if ! command -v node >/dev/null 2>&1; then
    echo "[dotenv] Node.js não encontrado para carregar $env_file" >&2
    return 1
  fi

  local project_root
  project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  local export_file
  export_file="$(mktemp)"

  if node - "$env_file" "$project_root" >"$export_file" <<'NODE'
const fs = require('fs');
const envPath = process.argv[2];
const projectRoot = process.argv[3];
const dotenvPath = require.resolve('dotenv', { paths: [projectRoot] });
const dotenv = require(dotenvPath);
const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));

for (const [key, value] of Object.entries(parsed)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  process.stdout.write(`${key}=${String(value)}\0`);
}
NODE
  then
    :
  else
    rm -f "$export_file"
    echo "[dotenv] não foi possível carregar $env_file" >&2
    return 1
  fi

  while IFS= read -r -d '' entry; do
    export "$entry"
  done < "$export_file"

  rm -f "$export_file"
}
