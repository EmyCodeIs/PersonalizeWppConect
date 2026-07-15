#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  xvfb \
  openbox \
  x11vnc \
  novnc \
  websockify \
  dbus-x11 \
  fonts-liberation

if command -v npm >/dev/null 2>&1; then
  sudo npm install -g pm2
else
  echo "[session-access] npm não encontrado; instale Node.js antes de configurar o PM2" >&2
fi

echo
echo "[session-access] dependências instaladas"
echo "[session-access] depois copie deploy/.env.vps.example para .env e configure senha/domínio"
echo "[session-access] teste inicial: npm run vps:start"
echo "[session-access] produção: pm2 start ecosystem.config.cjs && pm2 save"
echo
