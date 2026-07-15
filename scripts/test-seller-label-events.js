'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-seller-event-'));
process.chdir(tempDir);
process.env.MOCK_MODE = 'true';

async function main() {
  const Store = require('../src/services/leadStore');
  const SellerHandoff = require('../src/core/sellerHandoff');
  const {
    createSellerLabelUpdateHandler,
    extractLabelUpdateChatId,
  } = require('../src/core/sellerLabelEvents');

  const clientId = '5531999999922@c.us';
  const session = Store.getSession(clientId);
  session.completed = true;
  session.etapa = 'concluido';
  session.dados = { botDone: true, flow: 'letreiro' };
  Store.saveSession(session);

  assert.equal(
    extractLabelUpdateChatId({ chat: { id: { _serialized: clientId } } }),
    clientId,
  );

  const originalGetAutomationBlock = SellerHandoff.getAutomationBlock;
  let clearCount = 0;
  let mode = 'stale_after_add';
  SellerHandoff.getAutomationBlock = async () => {
    if (mode === 'stale_after_add') {
      // Simula a janela real em que o evento chegou, mas o Store do WhatsApp
      // ainda não refletiu a etiqueta. O payload do evento precisa bastar.
      return { blocked: false, source: 'no_seller_label_yet' };
    }
    return { blocked: false, source: 'seller_label_removed' };
  };

  try {
    const handler = createSellerLabelUpdateHandler({
      getChannel: () => ({ __isInternalLabelOperation: () => false }),
      clearBuffer: () => { clearCount += 1; },
      delayMs: 0,
    });

    const assigned = await handler({
      data: {
        chat: { id: { _serialized: clientId } },
        labels: [{ name: 'Ana' }],
        type: 'add',
      },
    });

    assert.equal(assigned.assigned, true);
    assert.equal(clearCount, 1);
    const assignedSession = Store.listSessions().find((item) => item.id === session.id);
    assert.equal(assignedSession.completed, true, 'o evento de vendedor não pode reabrir atendimento concluído');
    assert.equal(assignedSession.dados.sellerHandoff.status, 'assigned');
    assert.equal(assignedSession.dados.sellerHandoff.seller, 'ana');

    mode = 'released';
    const released = await handler({
      data: {
        chat: { id: { _serialized: clientId } },
        labels: [{ name: 'Ana' }],
        type: 'remove',
      },
    });
    assert.equal(released.released, true);
    const releasedSession = Store.listSessions().find((item) => item.id === session.id);
    assert.equal(releasedSession.dados.sellerHandoff.status, 'released');

    console.log('✅ Evento de etiqueta identifica vendedor mesmo após o pré-atendimento concluído.');
  } finally {
    SellerHandoff.getAutomationBlock = originalGetAutomationBlock;
  }
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
