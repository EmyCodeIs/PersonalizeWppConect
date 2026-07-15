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
process.env.LETTERING_CATALOG_SETTLE_MS = '0';
process.env.OUTBOUND_TEXT_ATTEMPTS = '2';
process.env.OUTBOUND_TEXT_RETRY_MS = '0';

function prepareSession(Store, clientId) {
  const session = Store.getSession(clientId);
  session.etapa = 'escolher_servico';
  session.completed = false;
  session.dados = { botDone: false };
  Store.saveSession(session);
}

async function main() {
  const ServiceLabels = require('../src/core/serviceLabels');
  const Store = require('../src/services/leadStore');
  const { messages } = require('../src/core/messages');
  const MenuCatalog = require('../src/core/menuCatalog');
  const { installMessageExperience } = require('../src/core/messageExperience');
  const events = [];

  const catalogSource = fs.readFileSync(path.join(__dirname, '../src/core/catalogMostruarioPreload.js'), 'utf8');
  const messageExperienceSource = fs.readFileSync(path.join(__dirname, '../src/core/messageExperience.js'), 'utf8');
  const showcaseSource = fs.readFileSync(path.join(__dirname, '../src/core/mostruario.js'), 'utf8');
  const obsoletePreload = path.join(__dirname, '../src/core/letteringIntroPreload.js');

  assert.equal(fs.existsSync(obsoletePreload), false, 'o preload antigo não pode voltar');
  assert.equal(catalogSource.includes('catalogSettleMs'), true, 'o catálogo precisa estabilizar antes do próximo balão');
  assert.equal(messageExperienceSource.includes('outbound_text_unconfirmed'), true, 'texto sem confirmação precisa interromper o fluxo');
  assert.equal(showcaseSource.includes('sendMostruarioLetreiro'), false, 'o mostruário antigo não pode voltar');
  assert.equal(showcaseSource.includes('getMostruarioImagePath'), false, 'a imagem antiga não pode voltar');

  const serviceRowsBefore = JSON.stringify(MenuCatalog.menus.servicos.rows);
  require('../src/core/supportAndServicesPreload');
  assert.equal(
    JSON.stringify(MenuCatalog.menus.servicos.rows),
    serviceRowsBefore,
    'carregar os fluxos complementares não pode alterar a lista inicial',
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
    prepareSession(Store, clientId);

    const channel = await WppClient.createMockChannel();
    channel.sendCatalog = async () => {
      events.push({ type: 'catalog' });
      return true;
    };
    channel.client.sendText = async (_id, message) => {
      events.push({ type: 'text', message });
      return { id: 'intro-message-id' };
    };
    channel.client.sendListMessage = async (_id, payload) => {
      events.push({ type: 'menu', title: payload?.title, description: payload?.description });
      return true;
    };
    installMessageExperience(channel);

    await processCustomerMessage({ clientId, text: 'serv_letreiro', channel, messages: [] });

    assert.deepEqual(events.map((item) => item.type), ['label', 'catalog', 'text', 'menu']);
    assert.equal(events[2].message, messages.letteringBudgetIntro);
    assert.match(String(events[3].description || ''), /tipo de acrílico/i);

    const failedClientId = '5531999999902@c.us';
    prepareSession(Store, failedClientId);
    const failedEvents = [];
    const failedChannel = await WppClient.createMockChannel();
    failedChannel.sendCatalog = async () => {
      failedEvents.push('catalog');
      return true;
    };
    failedChannel.client.sendText = async () => {
      failedEvents.push('text-failed');
      return false;
    };
    failedChannel.client.sendListMessage = async () => {
      failedEvents.push('menu');
      return true;
    };
    installMessageExperience(failedChannel);

    await assert.rejects(
      processCustomerMessage({ clientId: failedClientId, text: 'serv_letreiro', channel: failedChannel, messages: [] }),
      (error) => error?.code === 'outbound_text_unconfirmed',
    );

    assert.deepEqual(failedEvents, ['catalog', 'text-failed', 'text-failed']);
    assert.equal(failedEvents.includes('menu'), false, 'a lista não pode sair sem a explicação confirmada');

    console.log('✅ Sequência real protegida: catálogo → texto confirmado → lista; falha bloqueia a lista.');
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
