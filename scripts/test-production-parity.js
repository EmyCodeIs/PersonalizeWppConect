'use strict';

process.env.MOCK_MODE = 'true';
process.env.MIN_REPLY_DELAY_MS = '0';
process.env.MAX_REPLY_DELAY_MS = '0';
process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_LETREIRO_COLOR = 'purple';
process.env.SERVICE_LABEL_LETREIRO_COLOR_INDEX = '5';

const assert = require('assert');
const { messages } = require('../src/core/messages');
const { parseMedidasFromText } = require('../src/core/parsers');
const { processCustomerMessage } = require('../src/flow/customerFlow');
const { ensureLetreiroPurpleLabel } = require('../src/core/operationalLabelColorGuard');
const Store = require('../src/services/leadStore');

function createRecordingChannel() {
  const events = [];
  return {
    events,
    async sendText(clientId, text) {
      events.push({ type: 'text', clientId, text: String(text) });
      return true;
    },
    async sendImage(clientId, filePath, caption) {
      events.push({ type: 'image', clientId, filePath, caption });
      return true;
    },
    client: {
      async sendListMessage(clientId, payload) {
        events.push({ type: 'list', clientId, payload });
        return true;
      },
    },
  };
}

async function testMeasureParser() {
  const cases = [
    ['100x20', 100, 20],
    ['100 por 20', 100, 20],
    ['largura 100 e altura 20', 100, 20],
    ['100 de largura e 20 de altura', 100, 20],
    ['100 largura 20 altura', 100, 20],
    ['largura 100\naltura 20', 100, 20],
    ['1 metro de largura e 20cm de altura', 100, 20],
    ['100cm largura x 20cm altura', 100, 20],
    ['1m x 20cm', 100, 20],
  ];

  for (const [input, largura, altura] of cases) {
    const result = parseMedidasFromText(input, { largura: null, altura: null });
    assert.strictEqual(result.modo, 'completo', `modo incorreto para: ${input}`);
    assert.strictEqual(result.largura, largura, `largura incorreta para: ${input}`);
    assert.strictEqual(result.altura, altura, `altura incorreta para: ${input}`);
  }

  const widthOnly = parseMedidasFromText('100 de largura', {});
  assert.deepStrictEqual(
    { modo: widthOnly.modo, largura: widthOnly.largura, altura: widthOnly.altura },
    { modo: 'largura', largura: 100, altura: null },
  );

  const range = parseMedidasFromText('80-120cm de largura x 20-30cm de altura', {});
  assert.strictEqual(range.modo, 'descricao');
  assert.strictEqual(range.descricao, '80-120cm de largura x 20-30cm de altura');
}

async function testTextOnlyArtFlow() {
  const clientId = '5531999999911@c.us';
  const channel = createRecordingChannel();
  const session = Store.resetSession(clientId);
  session.etapa = 'espessura_personalizada';
  session.dados.tipoAcrilico = 'pintado';
  Store.saveSession(session);

  await processCustomerMessage({ clientId, text: '4mm', channel, messages: [] });

  const afterThickness = Store.getSession(clientId);
  assert.strictEqual(afterThickness.etapa, 'arte_coleta');
  assert.strictEqual(
    channel.events.some((event) => event.type === 'list' && /arte/i.test(JSON.stringify(event.payload))),
    false,
    'a etapa de arte não pode abrir uma lista',
  );

  const lastTexts = channel.events.filter((event) => event.type === 'text').slice(-3).map((event) => event.text);
  assert.deepStrictEqual(lastTexts, [
    messages.askArtQuestion,
    messages.askArtExplanation,
    messages.askArtFree,
  ]);

  const beforeDescriptionCount = channel.events.length;
  await processCustomerMessage({
    clientId,
    text: 'Quero o nome Personalize com uma fonte elegante',
    channel,
    messages: [],
  });

  const afterArt = Store.getSession(clientId);
  assert.strictEqual(afterArt.etapa, 'cidade');
  assert.strictEqual(afterArt.dados.arteModo, 'descrever');
  assert.strictEqual(afterArt.dados.arteTexto, 'Quero o nome Personalize com uma fonte elegante');
  assert.strictEqual(
    channel.events.slice(beforeDescriptionCount).some((event) => /Arte e referências anotadas/i.test(event.text || '')),
    false,
    'o oficial não envia confirmação extra antes da cidade',
  );
  assert.strictEqual(channel.events.at(-1).text, messages.askCity);
}

async function testMeasureFlowState() {
  const clientId = '5531999999922@c.us';
  const channel = createRecordingChannel();
  const session = Store.resetSession(clientId);
  session.etapa = 'tamanho';
  session.dados.tipoAcrilico = 'pintado';
  session.dados.tamanhoBuffer = [];
  session.dados.tamanhoParcial = { largura: null, altura: null };
  Store.saveSession(session);

  await processCustomerMessage({
    clientId,
    text: '100 de largura\n20 de altura',
    channel,
    messages: [],
  });

  const result = Store.getSession(clientId);
  assert.deepStrictEqual(result.dados.medida, { largura: 100, altura: 20 });
  assert.strictEqual(result.dados.tamanhoModo, 'completo');
  assert.strictEqual(result.etapa, 'espessura_personalizada');
  assert.strictEqual(
    channel.events.some((event) => event.type === 'text' && event.text === 'Medida anotada: 100 x 20 cm.'),
    true,
  );
}

async function testPurpleFallbackIndex() {
  const catalog = [{ id: '4', name: 'Orçamento letreiros', colorIndex: 1 }];
  const operations = [];
  let nextId = 20;
  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() { return catalog; },
        async getLabelColorPalette() { return []; },
      },
      lists: {
        async remove(id) {
          operations.push({ type: 'remove', id: String(id) });
          const index = catalog.findIndex((item) => String(item.id) === String(id));
          if (index >= 0) catalog.splice(index, 1);
        },
        async create(name, chatIds, colorIndex) {
          const id = String(nextId++);
          operations.push({ type: 'create', id, name, chatIds, colorIndex });
          catalog.push({ id, name, colorIndex });
          return id;
        },
      },
    },
  };

  const channel = {
    client: {
      page: {
        async evaluate(fn, args) {
          const previous = global.window;
          global.window = browserWindow;
          try { return await fn(args); } finally { global.window = previous; }
        },
      },
    },
  };

  const result = await ensureLetreiroPurpleLabel(channel);
  assert.strictEqual(result.ready, true);
  assert.strictEqual(result.colorIndex, 5);
  assert.strictEqual(operations.some((item) => item.type === 'remove' && item.id === '4'), true);
  assert.strictEqual(
    operations.some((item) => item.type === 'create' && item.colorIndex === 5),
    true,
    'sem paleta, o sistema precisa usar o índice roxo explícito e nunca undefined',
  );
}

async function run() {
  await testMeasureParser();
  await testTextOnlyArtFlow();
  await testMeasureFlowState();
  await testPurpleFallbackIndex();
  console.log('[TESTE PRODUÇÃO] arte por texto, medida inteligente e etiqueta roxa: OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
