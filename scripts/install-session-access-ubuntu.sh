#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y x11vnc novnc websockify xvfb openbox

echo
echo "Pacotes instalados."
echo "Agora garanta que o Chrome e o bot usem DISPLAY=:1 e suba uma tela virtual, por exemplo:"
echo "  Xvfb :1 -screen 0 1366x768x24 >/tmp/xvfb.log 2>&1 &"
echo "  export DISPLAY=:1"
echo