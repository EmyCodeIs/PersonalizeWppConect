'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findProfileMarkers } = require('./clean-token-cache-safe');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-token-cache-'));
try {
  const profile = path.join(root, 'personalize-wppconnect', 'Default');
  fs.mkdirSync(path.join(profile, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Cache', 'arquivo-cache'), 'cache');
  fs.writeFileSync(path.join(profile, 'Cookies'), 'dados-de-sessao');

  assert.deepEqual(findProfileMarkers(root), [], 'cache e Cookies não são marcadores de processo ativo');

  const lockPath = path.join(profile, 'SingletonLock');
  fs.writeFileSync(lockPath, 'lock');
  assert.deepEqual(findProfileMarkers(root), [lockPath]);

  console.log('✅ Limpeza de tokens bloqueia perfil ativo sem tratar Cookies como cache.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
