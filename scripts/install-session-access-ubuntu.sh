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

echo
echo "[session-access] dependências instaladas"
echo "[session-access] depois configure o bloco da VPS no .env"
echo "[session-access] para iniciar desktop + noVNC + bot: npm run vps:start"
echo
