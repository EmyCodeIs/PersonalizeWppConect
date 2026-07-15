'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-seller-alias-'));
process.chdir(tempDir);

process.env.SELLER_LABEL_BLOCKING_ENABLED = 'true';
process.env.SELLER_LABEL_RULES = 'Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100';
process.env.MAINTENANCE_INTERVAL_MS = '60000';

async function run() {
  const { resolveSellerLabelCandidates } = require('../src/core/sellerAliasHandoffPreload');

  const resolved = await resolveSellerLabelCandidates(
    {},
    '12345678901234@lid',
    { resolvePhoneJid: async () => '5531999999999@c.us' },
  );

  assert.equal(resolved.conclusiveIdentity, true);
  assert.ok(resolved.candidates.includes('12345678901234@lid'));
  assert.ok(resolved.candidates.includes('5531999999999@c.us'));

  const unresolved = await resolveSellerLabelCandidates(
    {},
    '98765432109876@lid',
    { resolvePhoneJid: async () => null },
  );

  assert.equal(unresolved.conclusiveIdentity, false);
  assert.deepEqual(unresolved.candidates, ['98765432109876@lid']);

  const directPhone = await resolveSellerLabelCandidates(
    {},
    '5531888888888@c.us',
    { resolvePhoneJid: async () => { throw new Error('não deveria resolver'); } },
  );

  assert.equal(directPhone.conclusiveIdentity, true);
  assert.ok(directPhone.candidates.includes('5531888888888@c.us'));

  console.log('✅ Handoff por aliases verificado: LID resolvido, falha inconclusiva e telefone direto.');
}

run()
  .catch((error) => {
    console.error('❌ Teste de aliases do vendedor falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
