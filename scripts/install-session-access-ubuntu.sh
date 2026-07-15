#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  nginx \
  apache2-utils \
  certbot \
  python3-certbot-nginx \
  xvfb \
  openbox \
  x11vnc \
  novnc \
  websockify \
  dbus-x11 \
  fonts-liberation \
  iproute2 \
  util-linux

if ! command -v google-chrome-stable >/dev/null 2>&1 \
  && ! command -v google-chrome >/dev/null 2>&1 \
  && ! command -v chromium >/dev/null 2>&1 \
  && ! command -v chromium-browser >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture)"

  if [[ "$ARCH" == "amd64" ]]; then
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor \
      | sudo tee /usr/share/keyrings/google-chrome.gpg >/dev/null

    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      | sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null

    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable
  else
    echo "[session-access] arquitetura $ARCH: tentando instalar Chromium" >&2
    if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser; then
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium
    fi
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[session-access] npm não encontrado; instale Node.js 20 a 24 antes de continuar" >&2
  exit 1
fi

sudo npm install -g pm2
sudo systemctl enable --now nginx

chmod +x "$ROOT_DIR"/scripts/*.sh
mkdir -p "$ROOT_DIR/data" "$ROOT_DIR/tokens"

echo
echo "[session-access] dependências instaladas"
echo "[session-access] copie deploy/.env.vps.example para .env e configure senha/domínio"
echo "[session-access] valide com: npm run vps:preflight"
echo "[session-access] configure HTTPS com: sudo bash scripts/configure-nginx-access.sh DOMINIO USUARIO"
echo "[session-access] produção: pm2 start ecosystem.config.cjs && pm2 save"
echo
