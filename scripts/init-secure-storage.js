'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Persistence = require('../src/services/persistence');

const dataDir = path.resolve(process.cwd(), 'data');
const sources = [
  ['sessions.json', { sessions: {}, lastSavedAt: null }],
  ['profiles.json', { profiles: {}, lastSavedAt: null }],
  ['contact-identities.json', { contacts: {}, aliases: {}, updatedAt: null }],
  ['human-control.json', { blocks: {}, lastSavedAt: null }],
  ['bot-activity.json', { contacts: {}, lastSavedAt: null }],
  ['system-state.json', { paused: false, reason: null, pausedAt: null, updatedAt: null }],
];

function main() {
  const info = Persistence.storageInfo();
  if (info.driver !== 'sqlite') {
    throw new Error('Defina STORAGE_DRIVER=sqlite no .env antes de inicializar a produção.');
  }

  fs.mkdirSync(dataDir, { recursive: true });
  for (const [name, fallback] of sources) {
    const filePath = path.join(dataDir, name);
    const value = Persistence.readJson(filePath, fallback);
    Persistence.writeJson(filePath, value);
  }
  const importedLeads = Persistence.importJsonLines(path.join(dataDir, 'leads.jsonl'));
  Persistence.getDatabase();
  Persistence.close();

  console.log(`[BANCO] SQLite criptografado pronto: ${info.databasePath}`);
  console.log(`[BANCO] leads legados importados nesta execução: ${importedLeads}`);
  console.log('[BANCO] arquivos antigos não foram apagados.');
}

try {
  main();
} catch (error) {
  console.error('[BANCO] falha:', error?.message || error);
  process.exitCode = 1;
}
