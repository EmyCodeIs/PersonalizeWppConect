'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Persistence = require('../src/services/persistence');

const apply = process.argv.includes('--apply');
const root = path.resolve(process.cwd(), 'data');
const names = [
  'sessions.json',
  'profiles.json',
  'contact-identities.json',
  'human-control.json',
  'bot-activity.json',
  'system-state.json',
  'leads.jsonl',
];
const files = {};

for (const name of names) {
  const filePath = path.join(root, name);
  if (!fs.existsSync(filePath)) continue;
  files[name] = fs.readFileSync(filePath, 'utf8');
}

if (!Object.keys(files).length) {
  console.log('[BANCO] nenhum arquivo legado em texto puro para selar.');
  process.exit(0);
}

if (Persistence.storageInfo().driver !== 'sqlite') {
  throw new Error('A selagem só pode ocorrer depois de STORAGE_DRIVER=sqlite e npm run storage:init.');
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const archivePath = path.join(root, `legacy-data-${timestamp}.enc`);
const payload = JSON.stringify({ createdAt: new Date().toISOString(), files });
const encrypted = Persistence.encryptText(payload);
fs.writeFileSync(archivePath, encrypted, { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(archivePath, 0o600);

const verified = JSON.parse(Persistence.decryptText(fs.readFileSync(archivePath, 'utf8')));
if (Object.keys(verified.files || {}).length !== Object.keys(files).length) {
  throw new Error('Falha na verificação do arquivo legado criptografado.');
}

if (apply) {
  for (const name of Object.keys(files)) fs.unlinkSync(path.join(root, name));
  console.log(`[BANCO] ${Object.keys(files).length} arquivo(s) legado(s) removido(s) após selagem verificada.`);
} else {
  console.log('[BANCO] simulação: originais preservados. Use --apply após validar.');
}
console.log(`[BANCO] arquivo legado criptografado: ${archivePath}`);
