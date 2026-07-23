'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-legacy-'));
const originalCwd = process.cwd();

function configureEnvironment() {
  process.env.MOCK_MODE = 'true';
  process.env.ENABLE_TEST_COMMANDS = 'false';
  process.env.ENABLE_CONTACT_NOTES = 'false';
  process.env.ENABLE_CONTACT_LABELS = 'false';
  process.env.ENABLE_TYPING = 'false';
  process.env.MIN_REPLY_DELAY_MS = '0';
  process.env.MAX_REPLY_DELAY_MS = '0';
  process.env.TYPING_MIN_MS = '0';
  process.env.TYPING_MAX_MS = '0';
  process.env.ALLOWED_CLIENT_NUMBERS = '';
  process.env.ALLOWED_CHAT_IDS = '';
}

function createSandboxAssets() {
  const assets = path.join(sandbox, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const file of [
    'capa_bem_vindos.jpg',
    'capa-mostruario.jpg',
    'tabela-cores-v2.jpg',
    'tabela-espessura.jpg',
    'tabela-profundidade-3mm.jpg',
  ]) {
    fs.writeFileSync(path.join(assets, file), 'legacy-test', 'utf8');
  }
}

function createChannel() {
  let sequence = 0;
  const events = [];
  const result = (prefix) => ({ id: `${prefix}-${++sequence}` });

  const client = {
    async sendText(chatId, text) {
      events.push({ type: 'text', chatId, text: String(text || '') });
      return result('text');
    },
    async sendImage(chatId, filePath, fileName, caption) {
      events.push({
        type: 'image',
        chatId,
        filePath: String(filePath || ''),
        fileName: String(fileName || ''),
        caption: String(caption || ''),
      });
      return result('image');
    },
    async sendListMessage(chatId, payload) {
      events.push({
        type: 'list',
        chatId,
        title: payload?.sections?.[0]?.title || '',
        rows: payload?.sections?.[0]?.rows || [],
        payload,
      });
      return result('list');
    },
  };

  const channel = {
    client,
    events,
    async sendText(chatId, text) {
      events.push({ type: 'text', chatId, text: String(text || '') });
      return result('text');
    },
    async sendImage(chatId, filePath, caption) {
      events.push({
        type: 'image',
        chatId,
        filePath: String(filePath || ''),
        fileName: path.basename(String(filePath || '')),
        caption: String(caption || ''),
      });
      return result('image');
    },
    async setContactNote(chatId, note) {
      events.push({ type: 'note', chatId, note: String(note || '') });
      return true;
    },
    drain() {
      return events.splice(0);
    },
  };

  return channel;
}

function findEvent(events, type, predicate = () => true) {
  return events.find((event) => event.type === type && predicate(event));
}

async function run() {
  configureEnvironment();
  createSandboxAssets();
  process.chdir(sandbox);

  const flowPath = path.join(projectRoot, 'src/flow/customerFlow');
  const storePath = path.join(projectRoot, 'src/services/leadStore');
  const messageExperiencePath = path.join(projectRoot, 'src/core/messageExperience');

  const { processCustomerMessage } = require(flowPath);
  const Store = require(storePath);
  const { installMessageExperience } = require(messageExperiencePath);
  const channel = installMessageExperience(createChannel());

  async function send(clientId, text, messages = []) {
    await processCustomerMessage({ clientId, text, channel, messages });
    return {
      session: Store.getSession(clientId),
      events: channel.drain(),
    };
  }

  const letteringId = '5531999000001@c.us';

  let step = await send(letteringId, 'Oi');
  assert.strictEqual(step.session.etapa, 'escolher_servico');
  assert.ok(findEvent(step.events, 'text', (event) => /Bem-vindo\(a\).*Personalize/i.test(event.text)));
  assert.ok(findEvent(step.events, 'image', (event) => /capa_bem_vindos/i.test(event.fileName)));
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Serviços'));

  step = await send(letteringId, 'serv_letreiro');
  assert.strictEqual(step.session.etapa, 'tipo_acrilico');
  assert.strictEqual(step.session.dados.flow, 'letreiro');
  assert.ok(findEvent(step.events, 'image', (event) => /capa-mostruario/i.test(event.fileName)));
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Tipo de acrílico'));

  step = await send(letteringId, 'acr_colorido');
  assert.strictEqual(step.session.etapa, 'cor_basica_qtd');
  assert.ok(findEvent(step.events, 'image', (event) => /tabela-cores-v2/i.test(event.fileName)));
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Quantidade de cores'));

  step = await send(letteringId, 'corq_1');
  assert.strictEqual(step.session.etapa, 'cor_basica_tipo');
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Tipo de cor'));

  step = await send(letteringId, 'cor_tipo_solida');
  assert.strictEqual(step.session.etapa, 'cor_basica_select_solida');
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Acrílico Cores Básicas 3mm'));

  step = await send(letteringId, 'cor_preto');
  assert.strictEqual(step.session.etapa, 'tamanho');
  assert.deepStrictEqual(step.session.dados.coresSelecionadas, ['Preto']);
  assert.ok(findEvent(step.events, 'text', (event) => /largura e altura/i.test(event.text)));

  step = await send(letteringId, '100x40');
  assert.strictEqual(step.session.etapa, 'espessura_extra_3mm');
  assert.strictEqual(step.session.dados.medida.largura, 100);
  assert.strictEqual(step.session.dados.medida.altura, 40);
  assert.ok(findEvent(step.events, 'image', (event) => /tabela-profundidade-3mm/i.test(event.fileName)));
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Espessura / profundidade'));

  step = await send(letteringId, 'esp3_keep');
  assert.strictEqual(step.session.etapa, 'arte_menu');
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Arte do letreiro'));

  step = await send(letteringId, 'art_ideia');
  assert.strictEqual(step.session.etapa, 'arte_coleta');
  assert.ok(findEvent(step.events, 'text', (event) => /Descreva como imagina/i.test(event.text)));
  assert.ok(findEvent(step.events, 'text', (event) => /mensagens separadas/i.test(event.text)));

  step = await send(letteringId, 'Logo preto com letras altas');
  assert.strictEqual(step.session.etapa, 'cidade');
  assert.strictEqual(step.session.dados.arteTexto, 'Logo preto com letras altas');
  assert.ok(findEvent(step.events, 'text', (event) => /cidade e estado/i.test(event.text)));

  delete require.cache[require.resolve(storePath)];
  const ReloadedStore = require(storePath);
  assert.strictEqual(
    ReloadedStore.getSession(letteringId).etapa,
    'cidade',
    'a etapa deve continuar persistida depois de recarregar o armazenamento',
  );

  step = await send(letteringId, 'Betim/MG');
  assert.strictEqual(step.session.etapa, 'envio');
  const deliveryMenu = findEvent(step.events, 'list', (event) => event.title === 'Envio');
  assert.ok(deliveryMenu);
  assert.ok(deliveryMenu.rows.some((row) => row.id === 'envio_instalacao'));

  step = await send(letteringId, 'envio_retirada_cliente');
  assert.strictEqual(step.session.etapa, 'observacao_pedido_menu');
  assert.strictEqual(step.session.dados.envio, 'Retirada');
  assert.ok(findEvent(step.events, 'text', (event) => /Rua Selênio 226/i.test(event.text)));
  assert.ok(findEvent(step.events, 'list', (event) => event.title === 'Observação do pedido'));

  step = await send(letteringId, 'OBS_PEDIDO|SKIP');
  assert.strictEqual(step.session.etapa, 'concluido');
  assert.strictEqual(step.session.completed, true);
  assert.strictEqual(step.session.dados.botDone, true);
  assert.ok(findEvent(step.events, 'text', (event) => /Registrei todas as informações/i.test(event.text)));

  const plotId = '5531999000002@c.us';
  await send(plotId, 'Oi');
  step = await send(plotId, 'serv_plotagem');
  assert.strictEqual(step.session.etapa, 'plotagem_descricao');
  step = await send(plotId, 'Plotagem de vitrine');
  assert.strictEqual(step.session.etapa, 'plotagem_medida');
  step = await send(plotId, '2x1m');
  assert.strictEqual(step.session.etapa, 'plotagem_local');
  step = await send(plotId, 'Vidro da fachada');
  assert.strictEqual(step.session.etapa, 'plotagem_prazo');
  step = await send(plotId, 'Até sexta-feira');
  assert.strictEqual(step.session.etapa, 'concluido');
  assert.strictEqual(step.session.dados.demanda.descricao, 'Plotagem de vitrine');

  const otherId = '5531999000003@c.us';
  await send(otherId, 'Oi');
  step = await send(otherId, 'serv_outros');
  assert.strictEqual(step.session.etapa, 'outros_descricao');
  step = await send(otherId, 'Uma placa para recepção');
  assert.strictEqual(step.session.etapa, 'outros_referencia');
  step = await send(otherId, '80x40 cm, tenho uma foto');
  assert.strictEqual(step.session.etapa, 'outros_prazo');
  step = await send(otherId, 'Sem urgência');
  assert.strictEqual(step.session.etapa, 'concluido');
  assert.strictEqual(step.session.dados.demanda.referencia, '80x40 cm, tenho uma foto');

  console.log('[FLUXO LEGADO] letreiro, persistência, plotagem e outros: OK');
}

run()
  .catch((error) => {
    console.error('[FLUXO LEGADO] FALHOU');
    console.error(error?.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
