'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DRIVER = String(process.env.STORAGE_DRIVER || 'file').trim().toLowerCase();
const DATABASE_PATH = path.resolve(
  process.cwd(),
  process.env.SQLITE_DATABASE_PATH || 'data/personalize.sqlite',
);

let database = null;

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.floor(ms)));
}

function atomicWrite(filePath, content) {
  ensureParent(filePath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');

  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) break;
      sleepSync(40 * attempt);
    }
  }

  try {
    fs.writeFileSync(filePath, content, 'utf8');
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
    return;
  } catch (error) {
    lastError = error;
  }

  try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  throw lastError;
}

function parseEncryptionKey() {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    throw new Error('DATA_ENCRYPTION_KEY ausente. Gere uma chave antes de usar STORAGE_DRIVER=sqlite.');
  }

  const candidates = [];
  if (/^[0-9a-f]{64}$/i.test(raw)) candidates.push(Buffer.from(raw, 'hex'));
  try { candidates.push(Buffer.from(raw, 'base64')); } catch (_) {}

  const key = candidates.find((item) => item.length === 32);
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY inválida. Use 32 bytes em Base64 ou 64 caracteres hexadecimais.');
  }
  return key;
}

function encryptText(value) {
  const key = parseEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

function decryptText(value) {
  const [version, ivEncoded, tagEncoded, encryptedEncoded] = String(value || '').split('.');
  if (version !== 'v1' || !ivEncoded || !tagEncoded || !encryptedEncoded) {
    throw new Error('Payload criptografado inválido ou incompatível.');
  }

  const key = parseEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivEncoded, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function getDatabase() {
  if (DRIVER !== 'sqlite') return null;
  if (database) return database;

  parseEncryptionKey();
  ensureParent(DATABASE_PATH);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    throw new Error(
      `STORAGE_DRIVER=sqlite exige Node.js 22 ou superior com node:sqlite disponível: ${error?.message || error}`,
    );
  }

  database = new DatabaseSync(DATABASE_PATH);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_size_limit = 16777216;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE IF NOT EXISTS secure_documents (
      document_key TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secure_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_key TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_secure_events_stream
      ON secure_events(stream_key, id);

    CREATE TABLE IF NOT EXISTS storage_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try { fs.chmodSync(DATABASE_PATH, 0o600); } catch (_) {}
  for (const suffix of ['-wal', '-shm']) {
    try {
      const candidate = `${DATABASE_PATH}${suffix}`;
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    } catch (_) {}
  }

  return database;
}

function documentKey(filePath) {
  return path.relative(DATA_DIR, path.resolve(filePath)).replace(/\\/g, '/');
}

function readLegacyJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJson(filePath, fallback) {
  if (DRIVER !== 'sqlite') return readLegacyJson(filePath, fallback);

  const db = getDatabase();
  const key = documentKey(filePath);
  const row = db.prepare(
    'SELECT encrypted_payload FROM secure_documents WHERE document_key = ?',
  ).get(key);

  if (row?.encrypted_payload) {
    try { return JSON.parse(decryptText(row.encrypted_payload)); } catch (error) {
      throw new Error(`Falha ao ler ${key} do banco criptografado: ${error?.message || error}`);
    }
  }

  const legacy = readLegacyJson(filePath, fallback);
  if (fs.existsSync(filePath)) {
    writeJson(filePath, legacy);
    setMetadata(`legacy-import:${key}`, new Date().toISOString());
    console.log(`[BANCO] legado importado para SQLite criptografado: ${key}`);
  }
  return legacy;
}

function writeJson(filePath, data) {
  const serialized = JSON.stringify(data, null, DRIVER === 'sqlite' ? 0 : 2);
  if (DRIVER !== 'sqlite') {
    atomicWrite(filePath, serialized);
    return;
  }

  const db = getDatabase();
  const key = documentKey(filePath);
  const encrypted = encryptText(serialized);
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO secure_documents(document_key, encrypted_payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(document_key) DO UPDATE SET
      encrypted_payload = excluded.encrypted_payload,
      updated_at = excluded.updated_at
  `).run(key, encrypted, timestamp);
}

function appendJsonLine(filePath, data) {
  if (DRIVER !== 'sqlite') {
    ensureParent(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, 'utf8');
    return;
  }

  const db = getDatabase();
  const stream = documentKey(filePath);
  db.prepare(`
    INSERT INTO secure_events(stream_key, encrypted_payload, created_at)
    VALUES (?, ?, ?)
  `).run(stream, encryptText(JSON.stringify(data)), new Date().toISOString());
}

function countJsonLines(filePath) {
  if (DRIVER !== 'sqlite') {
    try {
      if (!fs.existsSync(filePath)) return 0;
      return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim()).length;
    } catch (_) {
      return 0;
    }
  }

  const row = getDatabase().prepare(
    'SELECT COUNT(*) AS total FROM secure_events WHERE stream_key = ?',
  ).get(documentKey(filePath));
  return Number(row?.total || 0);
}

function clearJsonLines(filePath) {
  if (DRIVER !== 'sqlite') {
    ensureParent(filePath);
    fs.writeFileSync(filePath, '', 'utf8');
    return;
  }
  getDatabase().prepare('DELETE FROM secure_events WHERE stream_key = ?').run(documentKey(filePath));
}

function importJsonLines(filePath) {
  if (DRIVER !== 'sqlite' || !fs.existsSync(filePath)) return 0;
  const stream = documentKey(filePath);
  const marker = `legacy-stream-import:${stream}`;
  if (getMetadata(marker)) return 0;

  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim());
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO secure_events(stream_key, encrypted_payload, created_at)
    VALUES (?, ?, ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const line of lines) {
      const value = JSON.parse(line);
      insert.run(stream, encryptText(JSON.stringify(value)), value?.createdAt || new Date().toISOString());
    }
    setMetadata(marker, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (lines.length) console.log(`[BANCO] ${lines.length} evento(s) legado(s) importado(s): ${stream}`);
  return lines.length;
}

function setMetadata(key, value) {
  if (DRIVER !== 'sqlite') return;
  const timestamp = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO storage_metadata(metadata_key, metadata_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(metadata_key) DO UPDATE SET
      metadata_value = excluded.metadata_value,
      updated_at = excluded.updated_at
  `).run(String(key), String(value), timestamp);
}

function getMetadata(key) {
  if (DRIVER !== 'sqlite') return null;
  return getDatabase().prepare(
    'SELECT metadata_value FROM storage_metadata WHERE metadata_key = ?',
  ).get(String(key))?.metadata_value || null;
}

function storageInfo() {
  return {
    driver: DRIVER,
    databasePath: DRIVER === 'sqlite' ? DATABASE_PATH : null,
    encrypted: DRIVER === 'sqlite',
  };
}

function close() {
  if (!database) return;
  database.close();
  database = null;
}

module.exports = {
  appendJsonLine,
  clearJsonLines,
  close,
  countJsonLines,
  decryptText,
  encryptText,
  getDatabase,
  getMetadata,
  importJsonLines,
  readJson,
  setMetadata,
  storageInfo,
  writeJson,
};
