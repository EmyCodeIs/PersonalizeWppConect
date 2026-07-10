'use strict';

const assert = require('assert');
const Identity = require('../src/services/contactIdentity');
const ServiceLabels = require('../src/core/serviceLabels');

const {
  desiredHex,
  findCanonicalLabel,
  normalizeName,
} = ServiceLabels._test;

async function run() {
  assert.strictEqual(normalizeName('  Orçamento   LETREIRO '), 'orcamento letreiro');
  assert.strictEqual(desiredHex('purple'), '#7f66ff');
  assert.strictEqual(desiredHex('#123ABC'), '#123abc');

  const original = findCanonicalLabel([
    { id: '18', name: 'Orçamento letreiro', count: 0, colorIndex: 7 },
    { id: '12', name: 'Orçamento letreiro', count: 14, colorIndex: 5 },
    { id: '20', name: 'ORÇAMENTO LETREIRO', count: 30, colorIndex: 5 },
  ], 'Orçamento letreiro');

  assert.strictEqual(original.id, '12', 'deve preferir nome exato e etiqueta já usada');

  const tie = findCanonicalLabel([
    { id: '22', name: 'Plotagens', count: 0 },
    { id: '19', name: 'Plotagens', count: 0 },
  ], 'Plotagens');

  assert.strictEqual(tie.id, '19', 'em empate deve preferir o menor ID');

  assert.strictEqual(
    findCanonicalLabel([{ id: '1', name: '' }], 'Outros'),
    null,
    'etiqueta sem nome nunca pode ser reutilizada',
  );

  const originalGetCandidates = Identity.getLabelCandidateIds;
  const originalNormalize = Identity.normalizeChatId;
  Identity.normalizeChatId = (value) => String(value || '');
  Identity.getLabelCandidateIds = () => ['111@lid', '55111@c.us'];

  const labels = [
    { id: '5', name: 'Vendedor Adriano', count: 4, colorIndex: 1 },
    { id: '12', name: 'Etiqueta teste', count: 2, colorIndex: 7 },
  ];
  const chatLabels = new Map([
    ['55111@c.us', new Set(['5'])],
  ]);
  const operations = [];

  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() { return labels; },
        async addOrRemoveLabels(chatIds, options) {
          operations.push({ chatIds: [...chatIds], options: options.map((item) => ({ ...item })) });
          for (const chatId of chatIds) {
            const attached = chatLabels.get(chatId) || new Set();
            for (const option of options) {
              if (option.type === 'add') attached.add(String(option.labelId));
              if (option.type === 'remove') attached.delete(String(option.labelId));
            }
            chatLabels.set(chatId, attached);
          }
        },
      },
    },
    Store: {
      Chat: {
        get(chatId) {
          return chatLabels.has(chatId) ? { id: chatId } : null;
        },
        async find(chatId) {
          return chatLabels.has(chatId) ? { id: chatId } : null;
        },
      },
      Label: {
        getLabelsForModel(chat) {
          return [...(chatLabels.get(chat.id) || [])].map((id) => ({ id }));
        },
      },
    },
  };

  const client = {
    async getAllLabels() { return labels; },
    page: {
      async evaluate(fn, args) {
        const previousWindow = global.window;
        global.window = browserWindow;
        try {
          return await fn(args);
        } finally {
          global.window = previousWindow;
        }
      },
    },
  };

  try {
    const result = await ServiceLabels.applyNamedLabel(
      { client },
      '111@lid',
      { name: 'Etiqueta teste', color: 'purple' },
    );

    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.chatId, '55111@c.us', 'deve ignorar alias sem chat e usar o chat real');
    assert.deepStrictEqual(operations, [{
      chatIds: ['55111@c.us'],
      options: [{ labelId: '12', type: 'add' }],
    }]);
    assert.deepStrictEqual(
      [...chatLabels.get('55111@c.us')].sort(),
      ['12', '5'],
      'deve preservar a etiqueta manual do vendedor',
    );
  } finally {
    Identity.getLabelCandidateIds = originalGetCandidates;
    Identity.normalizeChatId = originalNormalize;
  }

  console.log('[TESTE ETIQUETAS] seleção, API, alias e preservação: OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
