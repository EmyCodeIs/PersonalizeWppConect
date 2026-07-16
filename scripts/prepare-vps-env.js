'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const templatePath = path.join(root, 'deploy', '.env.vps.ready.example');
const domain = String(process.argv[2] || process.env.SESSION_ACCESS_DOMAIN || '').trim().toLowerCase();

if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error('Uso: node scripts/prepare-vps-env.js whatsapp.seudominio.com.br');
  process.exit(1);
}

function parseCurrent(content) {
  const values = new Map();
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function setLine(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escaped}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.replace(/\s*$/, '')}\n${line}\n`;
}

const template = fs.readFileSync(templatePath, 'utf8').replaceAll('__DOMAIN__', domain);
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
let output = existing.trim() ? existing : template;
const current = parseCurrent(output);

const encryptionKey = current.get('DATA_ENCRYPTION_KEY');
if (!encryptionKey || encryptionKey.includes('__GENERATED_')) {
  output = setLine(output, 'DATA_ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64'));
}

const backupPassphrase = current.get('VPS_BACKUP_PASSPHRASE');
if (!backupPassphrase || backupPassphrase.includes('__GENERATED_')) {
  output = setLine(output, 'VPS_BACKUP_PASSPHRASE', crypto.randomBytes(32).toString('base64url'));
}

const required = {
  NODE_ENV: 'production',
  STORAGE_DRIVER: 'sqlite',
  SQLITE_DATABASE_PATH: 'data/personalize.sqlite',
  MOCK_MODE: 'false',
  WPP_HEADLESS: 'false',
  SESSION_ACCESS_HOST: '127.0.0.1',
  SESSION_ACCESS_ALLOW_PUBLIC_BIND: 'false',
  SESSION_ACCESS_PUBLIC_URL: `https://${domain}/vnc.html?autoconnect=true&resize=scale`,
  SESSION_ACCESS_HTTP_USER: 'personalize',
  SESSION_ACCESS_HTTP_PASSWORD: '2580',
  SESSION_ACCESS_PASSWORD: '2580',
  ALLOW_WEAK_SESSION_PASSWORD: 'true',
  BROWSER_CACHE_DIR: 'data/browser-cache',
  BROWSER_DISK_CACHE_MB: '100',
  BROWSER_MEDIA_CACHE_MB: '50',
  BROWSER_CACHE_MAX_MB: '200',
  BROWSER_CACHE_MAX_AGE_DAYS: '3',
  BROWSER_CACHE_AUTO_CLEAN: 'true',
  TOKEN_CACHE_AUTO_CLEAN: 'true',
};
for (const [key, value] of Object.entries(required)) output = setLine(output, key, value);

fs.writeFileSync(envPath, `${output.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
try { fs.chmodSync(envPath, 0o600); } catch (_) {}

console.log(`[VPS] .env preparado para: https://${domain}/vnc.html?autoconnect=true&resize=scale`);
console.log('[VPS] usuário do link: personalize');
console.log('[VPS] senha solicitada: 2580 (fraca; troca recomendada depois)');
console.log('[VPS] chave de banco e senha de backup geradas sem exibição no terminal.');
