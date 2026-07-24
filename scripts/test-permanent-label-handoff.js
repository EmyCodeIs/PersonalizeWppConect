'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-permanent-handoff-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.SELLER_LABEL_BLOCKING_ENABLED = 'true';
process.env.SELLER_LABEL_RULES = 'Ana=#00A4F2';
process.env.SERVICE_LABEL_LETREIRO = 'Letreiros';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_SUPPORT = 'Suporte';
process.env.SERVICE_LABEL_REPLACE_GROUP = 'Letreiros,Plotagens,Outros,Suporte';

async function run() {
  const { BufferManager } = require('../src/core/bufferManager');
  const { ChatTaskQueue } = require('../src/core/chatTaskQueue');
  const Cancellation = require('../src/core/automationCancellation');
  const HumanControl = require('../src/services/humanControlStore');
  const SellerHandoff = require('../src/core/sellerHandoff');
  const Permanent = require('../src/core/permanentLabelHandoffPreload');

  const managed = {
    available: true,
    ids: new Set(['svc-letreiro', 'svc-plotagem']),
    names: ['letreiros', 'plotagens', 'outros', 'suporte'],
  };

  assert.equal(
    Permanent.classifyAttachedLabels([{ id: 'svc-letreiro', name: 'Letreiros' }], managed).external,
    null,
  );

  const manual = Permanent.classifyAttachedLabels(
    [{ id: 'manual-financeiro', name: 'Financeiro' }],
    managed,
  ).external;
  assert.equal(manual.reason, 'manual_label');
  assert.equal(manual.labelId, 'manual-financeiro');

  const seller = Permanent.classifyAttachedLabels(
    [{ id: 'seller-ana', name: 'Ana' }],
    managed,
  ).external;
  assert.equal(seller.reason, 'seller_label');
  assert.equal(seller.seller, 'ana');

  const missingId = Permanent.classifyAttachedLabels([{ name: 'Letreiros' }], managed);
  assert.equal(missingId.conclusive, false);

  const clientId = '5531999999900@c.us';
  const buffer = new BufferManager({ delayMs: 60000, onFlush: async () => {} });
  buffer.push(clientId, { text: 'mensagem pendente' });
  assert.equal(buffer.map.has(clientId), true);

  const queue = new ChatTaskQueue({ maxUnits: 1, maxConcurrentChats: 1, taskTimeoutMs: 60000 });
  let releaseRunning;
  const running = queue.enqueue('5531999999800@c.us', () => new Promise((resolve) => {
    releaseRunning = resolve;
  }));
  const pending = queue.enqueue(clientId, async () => true);
  const pendingResult = pending.catch((error) => error);

  const cancelled = Cancellation.cancelContact(clientId, 'manual_label');
  assert.equal(cancelled.bufferedMessages, 1);
  assert.equal(cancelled.queuedTasks, 1);
  assert.equal(buffer.map.has(clientId), false);
  const cancelledError = await pendingResult;
  assert.equal(cancelledError.code, 'QUEUE_CANCELLED');

  releaseRunning(true);
  await running;

  HumanControl.setBlock(clientId, {
    reason: 'manual_label',
    source: 'test',
    labelName: 'Financeiro',
    persistent: true,
  });

  const originalBlockReader = SellerHandoff.getAutomationBlock;
  const channel = {
    client: {
      async sendText() { return true; },
    },
  };
  Permanent.installTransportGuards(channel);
  await assert.rejects(
    () => channel.client.sendText(clientId, 'não deve sair'),
    (error) => error?.code === 'HUMAN_HANDOFF_BLOCKED',
  );

  const stillBlocked = HumanControl.getBlock(clientId);
  assert.equal(stillBlocked.blocked, true);
  assert.equal(stillBlocked.control.blockedUntil, null);

  SellerHandoff.getAutomationBlock = originalBlockReader;
  console.log('✅ Handoff permanente: IDs internos liberados, etiqueta externa bloqueia, fila/buffer cancelados e transporte protegido.');
}

run()
  .catch((error) => {
    console.error('❌ Teste de handoff permanente falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
