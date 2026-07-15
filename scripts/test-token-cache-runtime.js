'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-token-runtime-'));
const tokens = path.join(tempDir, 'tokens');
const profile = path.join(tokens, 'personalize-wppconnect', 'Default');
const cache = path.join(profile, 'Cache');
fs.mkdirSync(cache, { recursive: true });

process.env.TOKEN_CACHE_ROOT = tokens;
process.env.TOKEN_CACHE_AUTO_CLEAN = 'true';
process.env.TOKEN_CACHE_MAX_AGE_DAYS = '0';
process.env.TOKEN_CACHE_FORCE_CLEAN_MB = '300';
process.env.TOKEN_CACHE_WARN_MB = '500';

const cacheFile = path.join(cache, 'data.bin');
const cookiesFile = path.join(profile, 'Cookies');
fs.writeFileSync(cacheFile, Buffer.alloc(2048));
fs.writeFileSync(cookiesFile, 'auth-preservada');

const {
  runStartupTokenCacheMaintenance,
  scanTokenCache,
} = require('../src/core/tokenCacheMaintenance');

try {
  const before = scanTokenCache({ root: tokens, maxAgeDays: 0 });
  assert.ok(before.cacheBytes >= 2048);
  const cleaned = runStartupTokenCacheMaintenance({ root: tokens, maxAgeDays: 0 });
  assert.equal(cleaned.skipped, false);
  assert.equal(fs.existsSync(cacheFile), false);
  assert.equal(fs.readFileSync(cookiesFile, 'utf8'), 'auth-preservada');

  fs.mkdirSync(cache, { recursive: true });
  const blockedCache = path.join(cache, 'blocked.bin');
  const marker = path.join(profile, 'DevToolsActivePort');
  fs.writeFileSync(blockedCache, Buffer.alloc(1024));
  fs.writeFileSync(marker, 'ativo');

  const blocked = runStartupTokenCacheMaintenance({ root: tokens, maxAgeDays: 0 });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'PROFILE_ACTIVE');
  assert.equal(fs.existsSync(blockedCache), true);
  assert.equal(fs.existsSync(cookiesFile), true);

  console.log('✅ Cache de tokens é limpo no início sem apagar autenticação e sem tocar perfil ativo.');
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
