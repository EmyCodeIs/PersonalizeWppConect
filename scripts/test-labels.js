'use strict';

const assert = require('assert');
const Identity = require('../src/services/contactIdentity');
const { env } = require('../src/config/env');
const ServiceLabels = require('../src/core/serviceLabels');

async function run() {
  assert.strictEqual(ServiceLabels._test.normalizeName('  Orçamento   LETREIROS '), 'orcamento letreiros');
  assert.strictEqual(ServiceLabels._test.desiredHex('green'), '#00a884');
  assert.deepStrictEqual(ServiceLabels._test.configuredGhostIds(), ['15']);

  const originalGetCandidates = Identity.getLabelCandidateIds;
  const originalNormalize = Identity.normalizeChatId;
  const originalGhostIds = env.legacyGhostLabelIds;

  Identity.normalizeChatId = (value) => String(value || '');
  Identity.getLabelCandidateIds = () => ['111@lid', '55111@c.us'];
  env.legacyGhostLabelIds = ['15'];

  const lists = [
    { id: '5', name: 'Adriano', count: 1, colorIndex: 3 },
  ];
  const chats = new Map([
    ['55111@c.us', new Set(['5', '15'])],
  ]);
  const hiddenModels = new Set(['15']);
  const operations = [];
  let nextId = 20;

  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() { return lists; },
        async getLabelColorPalette() { return ['#ea0038', '#00a884', '#667781']; },
        async addOrRemoveLabels(chatIds, options) {
          operations.push({ mode: 'labels-direct', chatIds: [...chatIds], options: options.map((item) => ({ ...item })) });
          for (const chatId of chatIds) {
            if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            for (const option of options) {
              if (option.type === 'remove') chats.get(chatId).delete(String(option.labelId));
              if (option.type === 'add') chats.get(chatId).add(String(option.labelId));
            }
          }
        },
        async addNewLabel() {
          throw new Error('addNewLabel não pode ser chamado');
        },
        async editLabel() {
          throw new Error('editLabel não pode ser chamado');
        },
      },
      lists: {
        async create(name, chatIds, colorIndex) {
          const id = String(nextId++);
          operations.push({ mode: 'create', id, name, chatIds: [...chatIds], colorIndex });
          lists.push({ id, name, count: 0, colorIndex });
          return id;
        },
        async addChats(listId, chatIds) {
          operations.push({ mode: 'addChats', listId: String(listId), chatIds: [...chatIds] });
          if (!lists.some((item) => String(item.id) === String(listId))) {
            throw new Error(`List ${listId} not found`);
          }
          for (const chatId of chatIds) {
            if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            chats.get(chatId).add(String(listId));
          }
        },
        async removeChats(listId, chatIds) {
          operations.push({ mode: 'removeChats', listId: String(listId), chatIds: [...chatIds] });
          if (!hiddenModels.has(String(listId)) && !lists.some((item) => String(item.id) === String(listId))) {
            throw new Error(`List ${listId} not found`);
          }
          for (const chatId of chatIds) {
            if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            chats.get(chatId).delete(String(listId));
          }
        },
        async remove(listId) {
          operations.push({ mode: 'removeList', listId: String(listId) });
          hiddenModels.delete(String(listId));
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
      { name: 'Orçamento letreiros', color: 'green' },
    );

    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.mode, 'wpp-lists');
    assert.strictEqual(result.chatId, '55111@c.us', 'deve ignorar o alias sem chat e usar o @c.us real');
    assert.strictEqual(result.targetId, '20');
    assert.strictEqual(result.targetName, 'Orçamento letreiros');

    assert.deepStrictEqual(
      [...chats.get('55111@c.us')].sort(),
      ['20', '5'],
      'deve remover o ID fantasma, preservar o vendedor e adicionar a lista real',
    );
    assert.strictEqual(hiddenModels.has('15'), false, 'o modelo local órfão deve ser apagado após desvincular');
    assert.strictEqual(
      operations.some((item) => item.mode === 'removeChats' && item.listId === '15'),
      true,
      'a limpeza deve usar WPP.lists.removeChats antes de apagar o modelo órfão',
    );
    assert.strictEqual(
      operations.some((item) => item.mode === 'removeList' && item.listId === '15'),
      true,
      'o modelo local órfão deve ser excluído depois da desvinculação',
    );
    assert.strictEqual(
      operations.filter((item) => item.mode === 'create' && item.name === 'Orçamento letreiros').length,
      1,
      'a lista real deve ser criada uma única vez por WPP.lists.create',
    );
    assert.strictEqual(
      operations.some((item) => item.mode === 'labels-direct' && item.options.some((option) => option.type === 'add')),
      false,
      'a lista nova não pode ser adicionada pelo caminho WPP.labels',
    );

    const second = await ServiceLabels.applyNamedLabel(
      { client },
      '55111@c.us',
      { name: 'Orçamento letreiros', color: 'green' },
    );

    assert.strictEqual(second.applied, true);
    assert.strictEqual(second.targetId, '20');
    assert.strictEqual(
      operations.filter((item) => item.mode === 'create').length,
      1,
      'a segunda aplicação deve reutilizar a lista real existente',
    );
  } finally {
    Identity.getLabelCandidateIds = originalGetCandidates;
    Identity.normalizeChatId = originalNormalize;
    env.legacyGhostLabelIds = originalGhostIds;
  }

  console.log('[TESTE LISTAS] causa raiz: WPP.lists, limpeza ID 15 e preservação do vendedor: OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
