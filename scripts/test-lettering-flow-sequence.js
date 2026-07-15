'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-lettering-sequence-'));
process.chdir(tempDir);
process.env.MOCK_MODE = 'true';
process.env.ENABLE_CONTACT_LABELS = 'true';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';

async function main() {
  const ServiceLabels = require('../src/core/serviceLabels');
  const Store = require('../src/services/leadStore');
  const { messages } = require('../src/core/messages');
  const events = [];

  const obsoletePreload = path.join(__dirname, '../src/core/letteringIntroPreload.js');
  assert.equal(
    fs.existsSync(obsoletePreload),
    false,
    'o fluxo não pode voltar a depender do preload antigo de introdução',
  );

  const startupSource = fs.readFileSync(
    path.join(__dirname, '../src/start-with-required-labels.js'),
    'utf8',
  );
  assert.equal(
    startupSource.includes('letteringIntroPreload'),
    false,
    'a inicialização não pode carregar o preload removido',
  );

  const originalReplace = ServiceLabels.replaceServiceLabel;
  ServiceLabels.replaceServiceLabel = async (_channel, clientId, service) => {
    events.push({ type: 'label', clientId, service });
    return { applied: true, verified: true, chatId: clientId };
  };

  try {
    require('../src/core/catalogMostruarioPreload');
    const WppClient = require('../src/services/wppconnectClient');
    const { processCustomerMessage } = require('../src/flow/customerFlow');

    const clientId = '5531999999901@c.us';
    const session = Store.getSession(clientId);
    session.etapa = 'escolher_servico';
    session.completed = false;
    session.dados = { botDone: false };
    Store.saveSession(session);

    const channel = await WppClient.createMockChannel();
    channel.sendCatalog = async () => {
      events.push({ type: 'catalog' });
      return true;
    };
    channel.sendText = async (_id, message) => {
      events.push({ type: 'text', message });
      return true;
    };
    channel.client.sendListMessage = async (_id, payload) => {
      events.push({ type: 'menu', title: payload?.title, description: payload?.description });
      return true;
    };

    await processCustomerMessage({
      clientId,
      text: 'serv_letreiro',
      channel,
      messages: [],
    });

    assert.deepEqual(events.map((item) => item.type), ['label', 'catalog', 'text', 'menu']);
    assert.equal(events[0].service, 'letreiro');
    assert.equal(events[2].message, messages.letteringBudgetIntro);
    assert.match(String(events[3].description || ''), /tipo de acrílico/i);
    assert.equal(Store.getSession(clientId).etapa, 'tipo_acrilico');

    console.log('✅ Fluxo real verificado sem preload: etiqueta → catálogo → explicação → lista de acrílico.');
  } finally {
    ServiceLabels.replaceServiceLabel = originalReplace;
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
