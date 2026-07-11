'use strict';

const assert = require('assert');
const Identity = require('../src/services/contactIdentity');
const ServiceLabels = require('../src/core/serviceLabels');

const {
  buildNameAliases,
  findCanonicalLabel,
  normalizeName,
} = ServiceLabels._test;

async function run() {
  assert.strictEqual(normalizeName('  Orçamento   LETREIROS '), 'orcamento letreiros');
  assert.deepStrictEqual(
    buildNameAliases({ name: 'Orçamento letreiros' }).map(normalizeName),
    ['orcamento letreiros', 'orcamento letreiro'],
  );

  const canonical = findCanonicalLabel([
    { id: '7', name: 'Orçamento letreiro', count: 0 },
    { id: '9', name: 'Orçamento letreiros', count: 10 },
  ], { name: 'Orçamento letreiros' });
  assert.strictEqual(canonical.id, '9', 'deve reutilizar a lista plural antiga que já tem contatos');

  const originalGetCandidates = Identity.getLabelCandidateIds;
  const originalNormalize = Identity.normalizeChatId;
  Identity.normalizeChatId = (value) => String(value || '');
  Identity.getLabelCandidateIds = () => ['111@lid', '55111@c.us'];

  const lists = [
    { id: '5', name: 'Adriano', count: 1, colorIndex: 1 },
    { id: '9', name: 'Orçamento letreiros', count: 10, colorIndex: 2 },
  ];
  const chats = new Map([['55111@c.us', new Set(['5'])]]);
  const operations = [];
  let createVisible = true;
  let nextId = 20;

  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() { return lists; },
        async getLabelColorPalette() { return ['#ff2e74', '#00a884', '#667781']; },
        async addOrRemoveLabels(chatIds, options) {
          operations.push({
            mode: 'labels',
            chatIds: [...chatIds],
            options: options.map((item) => ({ ...item })),
          });
          for (const chatId of chatIds) {
            if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            const attached = chats.get(chatId);
            for (const option of options) {
              if (option.type === 'add') attached.add(String(option.labelId));
              if (option.type === 'remove') attached.delete(String(option.labelId));
            }
          }
        },
      },
      lists: {
        async create(name, chatIds, colorIndex) {
          const id = String(nextId++);
          operations.push({ mode: 'create', id, name, chatIds: [...chatIds], colorIndex });
          if (createVisible) lists.push({ id, name, count: 0, colorIndex });
          return id;
        },
        async addChats(listId, chatIds) {
          operations.push({ mode: 'addChats', listId: String(listId), chatIds: [...chatIds] });
          if (!lists.some((item) => String(item.id) === String(listId))) {
            const err = new Error(`List ${listId} not found`);
            err.code = 'list_not_found';
            throw err;
          }
          for (const chatId of chatIds) {
            if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            chats.get(chatId).add(String(listId));
          }
        },
      },
    },
    Store: {
      Chat: {
        get(chatId) { return chats.has(chatId) ? { id: chatId } : null; },
        async find(chatId) { return chats.has(chatId) ? { id: chatId } : null; },
      },
      Label: {
        getLabelsForModel(chat) {
          return [...(chats.get(chat.id) || [])].map((id) => ({ id }));
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
      { name: 'Orçamento letreiro', color: 'green' },
    );

    assert.strictEqual(first.applied, true);
    assert.strictEqual(first.targetId, '9');
    assert.deepStrictEqual([...chats.get('55111@c.us')].sort(), ['5', '9']);

    chats.set('55111@c.us', new Set(['5']));
    createVisible = false;

    const blocked = await ServiceLabels.applyNamedLabel(
      { client },
      '55111@c.us',
      { name: 'Lista fantasma', color: 'purple' },
    );

    assert.strictEqual(blocked, false);
    assert.strictEqual(
      operations.some((item) => item.mode === 'addChats' && item.listId === '20'),
      false,
      'ID devolvido pela criação não pode ser aplicado se não apareceu no catálogo',
    );
    assert.deepStrictEqual([...chats.get('55111@c.us')], ['5']);

    createVisible = true;
    const created = await ServiceLabels.applyNamedLabel(
      { client },
      '55111@c.us',
      { name: 'Plotagens', color: 'gray' },
    );

    assert.strictEqual(created.applied, true);
    assert.ok(lists.some((item) => item.name === 'Plotagens'));
    assert.strictEqual(
      operations.some((item) => item.options?.some(
        (option) => option.type === 'remove' && option.labelId === '5',
      )),
      false,
      'a etiqueta manual do vendedor nunca deve ser removida',
    );
  } finally {
    Identity.getLabelCandidateIds = originalGetCandidates;
    Identity.normalizeChatId = originalNormalize;
  }

  console.log('[TESTE LISTAS] catálogo real, bloqueio de fantasma e preservação manual: OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
