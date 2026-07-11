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

  assert.strictEqual(original.id, '12', 'deve preferir nome exato e lista já utilizada');

  const tie = findCanonicalLabel([
    { id: '22', name: 'Plotagens', count: 0 },
    { id: '19', name: 'Plotagens', count: 0 },
  ], 'Plotagens');

  assert.strictEqual(tie.id, '19', 'em empate deve preferir o menor ID');
  assert.strictEqual(
    findCanonicalLabel([{ id: '1', name: '' }], 'Outros'),
    null,
    'lista sem nome nunca pode ser reutilizada',
  );

  const originalGetCandidates = Identity.getLabelCandidateIds;
  const originalNormalize = Identity.normalizeChatId;
  Identity.normalizeChatId = (value) => String(value || '');
  Identity.getLabelCandidateIds = () => ['111@lid', '55111@c.us'];

  const lists = [
    { id: '5', name: 'Adriano', count: 4, colorIndex: 1 },
  ];
  const chatLists = new Map([
    ['55111@c.us', new Set(['5'])],
  ]);
  const operations = [];
  let nextId = 12;

  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() { return lists; },
        async getLabelColorPalette() {
          return ['#ff2e74', '#d92d12', '#b554df', '#ff6433', '#c1845c'];
        },
        async addOrRemoveLabels(chatIds, options) {
          operations.push({ mode: 'labels-fallback', chatIds: [...chatIds], options });
          for (const chatId of chatIds) {
            const attached = chatLists.get(chatId) || new Set();
            for (const option of options) {
              if (option.type === 'add') attached.add(String(option.labelId));
              if (option.type === 'remove') attached.delete(String(option.labelId));
            }
            chatLists.set(chatId, attached);
          }
        },
      },
      lists: {
        async create(name, chatIds, colorIndex) {
          const id = String(nextId++);
          lists.push({ id, name, count: 0, colorIndex });
          operations.push({ mode: 'create', id, name, chatIds: [...chatIds], colorIndex });
          return id;
        },
        async addChats(listId, chatIds) {
          operations.push({ mode: 'addChats', listId: String(listId), chatIds: [...chatIds] });
          for (const chatId of chatIds) {
            if (!chatLists.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            chatLists.get(chatId).add(String(listId));
          }
        },
      },
    },
    Store: {
      Chat: {
        get(chatId) {
          return chatLists.has(chatId) ? { id: chatId } : null;
        },
        async find(chatId) {
          return chatLists.has(chatId) ? { id: chatId } : null;
        },
      },
      Label: {
        getLabelsForModel(chat) {
          return [...(chatLists.get(chat.id) || [])].map((id) => ({ id }));
        },
      },
    },
  };

  const client = {
    async getAllLabels() { return lists; },
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
    const first = await ServiceLabels.applyNamedLabel(
      { client },
      '111@lid',
      { name: 'Orçamento letreiro', color: 'purple' },
    );

    assert.strictEqual(first.applied, true);
    assert.strictEqual(first.verified, true);
    assert.strictEqual(first.chatId, '55111@c.us', 'deve usar o chat real e ignorar alias inexistente');
    assert.strictEqual(first.targetName, 'Orçamento letreiro');
    assert.strictEqual(lists.filter((item) => item.name === 'Orçamento letreiro').length, 1);
    assert.deepStrictEqual(
      [...chatLists.get('55111@c.us')].sort(),
      ['12', '5'],
      'deve manter a lista do vendedor e adicionar a lista de serviço',
    );

    const second = await ServiceLabels.applyNamedLabel(
      { client },
      '55111@c.us',
      { name: 'Orçamento letreiro', color: 'purple' },
    );

    assert.strictEqual(second.applied, true);
    assert.strictEqual(second.alreadyAttached, true);
    assert.strictEqual(
      operations.filter((item) => item.mode === 'create').length,
      1,
      'a lista deve ser criada uma única vez',
    );
    assert.strictEqual(
      operations.some((item) => item.options?.some((option) => option.type === 'remove')),
      false,
      'nenhuma lista manual pode ser removida',
    );
  } finally {
    Identity.getLabelCandidateIds = originalGetCandidates;
    Identity.normalizeChatId = originalNormalize;
  }

  console.log('[TESTE LISTAS] criação única, vínculo, alias e preservação: OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
