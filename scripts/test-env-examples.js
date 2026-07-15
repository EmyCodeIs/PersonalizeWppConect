'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const filePath = path.join(__dirname, '..', 'deploy', '.env.vps.example');
const parsed = dotenv.parse(fs.readFileSync(filePath));
const rules = String(parsed.SELLER_LABEL_RULES || '');

for (const expected of [
  'Adriano=#8FD0A8',
  'Ana=#00A4F2',
  'Emy=#7FE51F',
  'C. Eduardo=#FEB100',
]) {
  assert.ok(rules.includes(expected), `regra ausente ou cortada pelo dotenv: ${expected}`);
}

assert.equal(parsed.ENABLE_TEST_COMMANDS, 'false');
assert.equal(parsed.ENABLE_UNREAD_BOOTSTRAP, 'false');
assert.equal(parsed.LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES, 'false');
assert.equal(parsed.SESSION_ACCESS_HOST, '127.0.0.1');

console.log('✅ Ambiente VPS verificado: regras hex preservadas, testes/não lidas/exclusões desligados e noVNC privado.');
