'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-single-art-flow-'));
process.chdir(tempDir);

process.env.MOCK_MODE = 'true';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';

async function run() {
  const { messages } = require('../src/core/messages');
  const MenuCatalog = require('../src/core/menuCatalog');
  const Store = require('../src/services/leadStore');
  const CustomerFlow = require('../src/flow/customerFlow');

  assert.equal(Object.hasOwn(MenuCatalog.menus, 'arte'), false, 'o menu antigo de arte não pode existir');
  for (const messageName of ['askArtFile', 'askArtImage', 'askArtDescription']) {
    assert.equal(Object.hasOwn(messages, messageName), false, `mensagem obsoleta ainda existe: ${messageName}`);
  }

  const source = fs.readFileSync(path.join(__dirname, '../src/flow/customerFlow.js'), 'utf8');
  for (const obsolete of ['arte_menu', 'art_arquivo', 'art_imagem', 'art_ideia', "sendMenu(channel, id, 'arte')"]) {
    assert.equal(source.includes(obsolete), false, `rota antiga ainda existe no fluxo: ${obsolete}`);
  }

  const stageOwners = {
    customerFlow: source,
    fixes: fs.readFileSync(path.join(__dirname, '../src/core/customerFlowFixPreload.js'), 'utf8'),
    services: fs.readFileSync(path.join(__dirname, '../src/core/supportAndServicesPreload.js'), 'utf8'),
  };
  for (const stage of [
    'plotagem_descricao', 'plotagem_medida', 'plotagem_local', 'plotagem_prazo',
    'outros_descricao', 'outros_referencia', 'outros_prazo',
  ]) {
    assert.equal(stageOwners.customerFlow.includes(`s.etapa === '${stage}'`), false, `etapa duplicada no fluxo-base: ${stage}`);
    assert.equal(stageOwners.services.includes(`session.etapa === '${stage}'`), true, `dono atual da etapa ausente: ${stage}`);
  }
  for (const stage of ['envio', 'endereco']) {
    assert.equal(stageOwners.customerFlow.includes(`s.etapa === '${stage}'`), false, `etapa duplicada no fluxo-base: ${stage}`);
    assert.equal(stageOwners.fixes.includes(`session.etapa === '${stage}'`), true, `dono atual da etapa ausente: ${stage}`);
  }

  const clientId = '5531999999900';
  const session = Store.getSession(clientId);
  session.etapa = 'espessura_personalizada';
  session.dados = { flow: 'letreiro', tipoAcrilico: 'pintado' };
  Store.saveSession(session);

  const sent = [];
  await CustomerFlow.processCustomerMessage({
    clientId,
    text: '6mm',
    channel: { sendText: async (_id, text) => sent.push(text) },
    messages: [],
  });

  const collecting = Store.getSession(clientId);
  assert.equal(collecting.etapa, 'arte_coleta');
  assert.equal(collecting.dados.arteModo, 'livre');
  assert.deepEqual(sent.slice(-3), [
    messages.askArtQuestion,
    messages.askArtExplanation,
    messages.askArtFree,
  ]);

  const legacyClientId = '5531999999901';
  const legacy = Store.getSession(legacyClientId);
  legacy.etapa = 'arte_menu';
  legacy.dados = { flow: 'letreiro' };
  Store.saveSession(legacy);
  const migrated = Store.getSession(legacyClientId);
  assert.equal(migrated.etapa, 'arte_coleta');
  assert.equal(migrated.dados.arteModo, 'livre');

  console.log('✅ Arte usa uma única rota: coleta livre por texto ou mídia.');
}

run()
  .catch((error) => {
    console.error('❌ Teste do fluxo único de arte falhou:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
