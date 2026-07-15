#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOMAIN="${1:-}"
ACCESS_USER="${2:-vendedor}"
AVAILABLE_FILE="/etc/nginx/sites-available/personalize-whatsapp"
ENABLED_FILE="/etc/nginx/sites-enabled/personalize-whatsapp"
PASSWORD_FILE="/etc/nginx/.htpasswd-whatsapp"
TEMPLATE_FILE="$ROOT_DIR/deploy/nginx-whatsapp.conf"

if [[ -z "$DOMAIN" ]]; then
  echo "Uso: sudo bash scripts/configure-nginx-access.sh whatsapp.seudominio.com.br vendedor" >&2
  exit 1
fi

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || [[ "$DOMAIN" != *.* ]]; then
  echo "[nginx] domínio inválido: $DOMAIN" >&2
  exit 1
fi

for command in nginx certbot htpasswd sed; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[nginx] comando obrigatório ausente: $command" >&2
    exit 1
  fi
done

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "[nginx] template ausente: $TEMPLATE_FILE" >&2
  exit 1
fi

if [[ -f "$PASSWORD_FILE" ]]; then
  htpasswd "$PASSWORD_FILE" "$ACCESS_USER"
else
  htpasswd -c "$PASSWORD_FILE" "$ACCESS_USER"
fi
chown root:www-data "$PASSWORD_FILE"
chmod 640 "$PASSWORD_FILE"

# Configuração temporária: atende apenas o desafio do certificado e não publica
# o noVNC por HTTP.
cat > "$AVAILABLE_FILE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 503;
    }
}
EOF

ln -sfn "$AVAILABLE_FILE" "$ENABLED_FILE"
nginx -t
systemctl reload nginx

echo "[nginx] solicitando certificado para $DOMAIN"
certbot certonly --nginx -d "$DOMAIN"

sed "s/__DOMAIN__/$DOMAIN/g" "$TEMPLATE_FILE" > "$AVAILABLE_FILE"
nginx -t
systemctl reload nginx

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null || true
  ufw allow 'Nginx Full' >/dev/null || true
  ufw deny 5901/tcp >/dev/null || true
  ufw deny 6080/tcp >/dev/null || true
  echo "[nginx] regras do UFW adicionadas; o script não ativou o firewall automaticamente"
fi

echo
echo "[nginx] acesso configurado"
echo "[nginx] URL: https://$DOMAIN/vnc.html?autoconnect=true&resize=scale"
echo "[nginx] usuário HTTP: $ACCESS_USER"
echo "[nginx] a senha HTTP e a senha VNC são camadas separadas"
echo
