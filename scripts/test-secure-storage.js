'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-secure-storage-'));
process.chdir(tempDir);
process.env.STORAGE_DRIVER = 'sqlite';
process.env.SQLITE_DATABASE_PATH = 'data/test.sqlite';
process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

async function main() {
  const Persistence = require('../src/services/persistence');
  const sessionsPath = path.join(tempDir, 'data', 'sessions.json');
  const leadsPath = path.join(tempDir, 'data', 'leads.jsonl');
  const secret = 'Rua confidencial 123';

  Persistence.writeJson(sessionsPath, {
    sessions: {
      customer: { nome: 'Cliente Privado', endereco: secret },
    },
  });

  const restored = Persistence.readJson(sessionsPath, null);
  assert.equal(restored.sessions.customer.endereco, secret);

  const dbBytes = fs.readFileSync(path.join(tempDir, 'data', 'test.sqlite'));
  assert.equal(dbBytes.includes(Buffer.from(secret, 'utf8')), false, 'dado sensível não pode aparecer em texto puro no SQLite');
  assert.equal(dbBytes.includes(Buffer.from('Cliente Privado', 'utf8')), false, 'nome não pode aparecer em texto puro no SQLite');

  Persistence.appendJsonLine(leadsPath, { id: 'lead-1', observation: secret });
  assert.equal(Persistence.countJsonLines(leadsPath), 1);
  const dbAfterLead = fs.readFileSync(path.join(tempDir, 'data', 'test.sqlite'));
  assert.equal(dbAfterLead.includes(Buffer.from(secret, 'utf8')), false);

  const goodKey = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  assert.throws(
    () => Persistence.readJson(sessionsPath, null),
    /Falha ao ler|authenticate|autenticar|Unsupported state/i,
  );
  process.env.DATA_ENCRYPTION_KEY = goodKey;

  const legacyPath = path.join(tempDir, 'data', 'profiles.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ profiles: { a: { knownName: 'Nome legado' } } }), 'utf8');
  const imported = Persistence.readJson(legacyPath, {});
  assert.equal(imported.profiles.a.knownName, 'Nome legado');
  fs.writeFileSync(legacyPath, JSON.stringify({ profiles: {} }), 'utf8');
  assert.equal(Persistence.readJson(legacyPath, {}).profiles.a.knownName, 'Nome legado');

  Persistence.clearJsonLines(leadsPath);
  assert.equal(Persistence.countJsonLines(leadsPath), 0);
  assert.deepEqual(Persistence.storageInfo(), {
    driver: 'sqlite',
    databasePath: path.join(tempDir, 'data', 'test.sqlite'),
    encrypted: true,
  });

  Persistence.close();
  console.log('✅ SQLite leve validado: snapshots/eventos criptografados, migração e chave incorreta bloqueada.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
