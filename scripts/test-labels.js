'use strict';

const assert = require('assert');
const Identity = require('../src/services/contactIdentity');
const ServiceLabels = require('../src/core/serviceLabels');

const {
  buildNameAliases,
  desiredHex,
  findCanonicalLabel,
  invalidateResolvedList,
  normalizeName,
  resolvedLists,
} = ServiceLabels._test;

async function run() {
  assert.strictEqual(normalizeName('  Orçamento   LETREIROS '), 'orcamento letreiros');
  assert.deepStrictEqual(
    buildNameAliases({ name: 'Orçamento letreiro' }).map(normalizeName),
    ['orcamento letreiro', 'orcamento letreiros'],
  );
  assert.strictEqual(desiredHex('purple'), '#7f66ff');

  const legacyUsed = findCanonicalLabel([
    { id: '18', name: 'Orçamento letreiro', count: 0 },
    { id: '12', name: 'Orçamento letreiros', count: 14 },
  ], { name: 'Orçamento letreiro' });
  assert.strictEqual(legacyUsed.id, '12', 'deve reutilizar a lista plural antiga que já tem contatos');

  const exactUsed = findCanonicalLabel([
    { id: '18', name: 'Orçamento letreiro', count: 20 },
    { id: '12', name: 'Orçamento letreiros', count: 14 },
  ], { name: 'Orçamento letreiro' });
  assert.strictEqual(exactUsed.id, '18', 'deve preferir a configurada quando também está em uso');

  const originalGetCandidates = Identity.getLabelCandidateIds;
  const originalNormalize = Identity.normalizeChatId;
  Identity.normalizeChatId = (value) => String(value || '');
  Identity.getLabelCandidateIds = () => ['111@lid', '55111@c.us'];

  const lists = [
    { id: '5', name: 'Adriano', count: 4, colorIndex: 1 },
    { id: '12', name: 'Orçamento letreiros', count: 14, colorIndex: 2 },
  ];
  const chatLists = new Map([
    ['55111@c.us', new Set(['5'])],
  ]);
  const operations = [];
  let hideNewLabelFromVerification = true;
  let nextId = 20;

  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() { return lists; },
        async getLabelColorPalette() { return ['#ff2e74', '#7f66ff', '#00a884']; },
        async addOrRemoveLabels(chatIds, options) {
          operations.push({ mode: 'labels', chatIds: [...chatIds], options: options.map((item) => ({ ...item })) });
          for (const chatId of chatIds) {
            if (!chatLists.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            const attached = chatLists.get(chatId);
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
          lists.push({ id, name, count: 0, colorIndex });
          operations.push({ mode: 'create', id, name, chatIds: [...chatIds], colorIndex });
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
            if (!chatLists.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            chatLists.get(chatId).add(String(listId));
          }
        },
      },
    },
    Store: {
      Chat: {
        get(chatId) { return chatLists.has(chatId) ? { id: chatId } : null; },
        async find(chatId) { return chatLists.has(chatId) ? { id: chatId } : null; },
      },
      Label: {
        getLabelsForModel(chat) {
          const ids = [...(chatLists.get(chat.id) || [])];
          return ids
            .filter((id) => !(hideNewLabelFromVerification && id !== '5'))
            .map((id) => ({ id }));
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
    assert.strictEqual(first.verified, null, 'atraso do Store não pode transformar a escrita em falha');
    assert.strictEqual(first.chatId, '55111@c.us');
    assert.strictEqual(first.targetId, '12');
    assert.strictEqual(first.targetName, 'Orçamento letreiros');
    assert.deepStrictEqual([...chatLists.get('55111@c.us')].sort(), ['12', '5']);
    assert.strictEqual(
      operations.some((item) => item.options?.some((option) => option.type === 'remove')),
      false,
      'nunca deve remover etiquetas de vendedor ou outras etiquetas',
    );

    const oldIndex = lists.findIndex((item) => item.id === '12');
    lists.splice(oldIndex, 1, { id: '15', name: 'Orçamento letreiros', count: 1, colorIndex: 2 });
    chatLists.set('55111@c.us', new Set(['5']));
    hideNewLabelFromVerification = false;

    const recovered = await ServiceLabels.applyNamedLabel(
      { client },
      '55111@c.us',
      { name: 'Orçamento letreiro', color: 'purple' },
    );

    assert.strictEqual(recovered.applied, true);
    assert.strictEqual(recovered.verified, true);
    assert.strictEqual(recovered.targetId, '15', 'deve invalidar cache e localizar o novo ID');
    assert.deepStrictEqual([...chatLists.get('55111@c.us')].sort(), ['15', '5']);

    invalidateResolvedList({ name: 'Plotagens' });
    const createdFirst = await ServiceLabels.applyNamedLabel(
      { client },
      '55111@c.us',
      { name: 'Plotagens', color: 'gray' },
    );
    const createdSecond = await ServiceLabels.applyNamedLabel(
      { client },
      '55111@c.us',
      { name: 'Plotagens', color: 'gray' },
    );

    assert.strictEqual(createdFirst.applied, true);
    assert.strictEqual(createdSecond.alreadyAttached, true);
    assert.strictEqual(
      operations.filter((item) => item.mode === 'create' && item.name === 'Plotagens').length,
      1,
      'lista ausente deve ser criada somente uma vez',
    );
    assert.ok(resolvedLists.size >= 1);
  } finally {
    Identity.getLabelCandidateIds = originalGetCandidates;
    Identity.normalizeChatId = originalNormalize;
  }

  console.log('[TESTE LISTAS] aliases, aplicação aditiva, atraso, cache inválido e criação única: OK');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
