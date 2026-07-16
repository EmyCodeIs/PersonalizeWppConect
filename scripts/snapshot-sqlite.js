'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const source = path.resolve(process.cwd(), process.env.SQLITE_DATABASE_PATH || 'data/personalize.sqlite');
const destination = path.resolve(process.argv[2] || path.join(process.cwd(), 'data', 'personalize-backup.sqlite'));

if (!fs.existsSync(source)) {
  console.error(`[backup] banco não encontrado: ${source}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
try { if (fs.existsSync(destination)) fs.unlinkSync(destination); } catch (_) {}

const db = new DatabaseSync(source);
try {
  db.exec('PRAGMA wal_checkpoint(FULL);');
  const escaped = destination.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}
try { fs.chmodSync(destination, 0o600); } catch (_) {}
console.log(`[backup] snapshot SQLite consistente: ${destination}`);
