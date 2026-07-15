'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-handoff-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.SELLER_LABEL_RULES = 'Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100';
process.env.MAINTENANCE_INTERVAL_MS = '60000';

async function run() {
  const SellerHandoff = require('../src/core/sellerHandoff');
  const HumanControl = require('../src/services/humanControlStore');

  let attachedLabels = [{ id: 'seller-ana', name: 'Ana', hexColor: '#00a4f2' }];
  SellerHandoff._test.inspectChatLabels = async () => ({
    available: true,
    chatFound: true,
    items: attachedLabels,
  });
  SellerHandoff._test.orderedCandidateIds = (clientId) => [String(clientId)];

  require('../src/core/vpsReadinessPreload');

  const channel = { client: {} };
  const clientId = '5531999999933@c.us';

  const assigned = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(assigned.blocked, true);
  assert.equal(assigned.reason, 'seller_label');
  assert.equal(assigned.seller, 'ana');
  assert.equal(HumanControl.getBlock(clientId).blocked, true);

  attachedLabels = [];
  const released = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(released.blocked, false);
  assert.equal(released.source, 'seller_label_removed');
  assert.equal(HumanControl.getBlock(clientId).blocked, false);

  HumanControl.setBlock(clientId, {
    reason: 'manual_outbound_message',
    source: 'manual_outbound_message',
    persistent: true,
  });

  const manual = await SellerHandoff.getAutomationBlock(channel, clientId);
  assert.equal(manual.blocked, true);
  assert.equal(manual.reason, 'manual_outbound_message');
  assert.equal(HumanControl.getBlock(clientId).control.blockedUntil, null);

  console.log('✅ Handoff verificado: assumir, liberar etiqueta e preservar atendimento manual.');
}

run()
  .catch((error) => {
    console.error('❌ Teste de handoff falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
