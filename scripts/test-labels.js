'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEST_STORE = path.join('data', 'contact-labels.test.json');
process.env.CONTACT_LABEL_STORE_PATH = TEST_STORE;
process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_LETREIRO_COLOR = 'purple';
process.env.SERVICE_LABEL_LETREIRO_COLOR_HEX = '#7f66ff';
process.env.SERVICE_LABEL_LETREIRO_COLOR_INDEX = '5';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_PLOTAGEM_COLOR = 'gray';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_OUTROS_COLOR = 'red';
process.env.SUPPORT_LABEL_NAME = 'Suporte';
process.env.SUPPORT_LABEL_COLOR = 'red';
process.env.SELLER_NAMES = 'Adriano;Aninha;Carlos';
process.env.MARK_SELLER_CLIENT_UNREAD = 'true';
process.env.RECREATE_MISMATCHED_OPERATIONAL_LABELS = 'true';
process.env.CLEANUP_DUPLICATE_OPERATIONAL_LABELS = 'true';
process.env.LABEL_OBSERVATION_MIN_INTERVAL_MS = '0';
process.env.LABEL_RECONCILE_DELAY_MS = '0';

try { fs.unlinkSync(TEST_STORE); } catch (_) {}
try { fs.unlinkSync(`${TEST_STORE}.tmp`); } catch (_) {}

const Identity = require('../src/services/contactIdentity');
const ContactLabels = require('../src/services/contactLabelStore');
const ServiceLabels = require('../src/core/serviceLabels');

async function run() {
  const originals = {
    normalizeChatId: Identity.normalizeChatId,
    getLabelCandidateIds: Identity.getLabelCandidateIds,
    getSessionKey: Identity.getSessionKey,
    resolveContact: Identity.resolveContact,
  };

  Identity.normalizeChatId = (value) => String(value || '');
  Identity.getLabelCandidateIds = (value) => String(value) === 'novo@c.us'
    ? ['novo@c.us']
    : ['111@lid', '55111@c.us'];
  Identity.getSessionKey = (value) => String(value) === 'novo@c.us'
    ? 'wa:new-contact'
    : 'wa:test-contact';
  Identity.resolveContact = (value) => String(value) === 'novo@c.us'
    ? {
      contactKey: 'wa:new-contact',
      primaryChatId: 'novo@c.us',
      aliases: ['novo@c.us'],
      lid: null,
      cUsId: 'novo@c.us',
      phone: null,
    }
    : {
      contactKey: 'wa:test-contact',
      primaryChatId: '55111@c.us',
      aliases: ['111@lid', '55111@c.us'],
      lid: '111@lid',
      cUsId: '55111@c.us',
      phone: '55111',
    };

  const palette = [
    '#ea0038',
    '#00a884',
    '#667781',
    '#027eb5',
    '#f7b928',
    '#7f66ff',
  ];
  let nextId = 20;
  const catalog = [
    // Cenário real do print: duas etiquetas com o mesmo nome.
    { id: '4', name: 'Orçamento letreiros', colorIndex: 1, count: 1 },
    { id: '9', name: 'Orçamento letreiros', colorIndex: 5, count: 0 },
    { id: '50', name: 'VIP', colorIndex: 4, count: 1 },
  ];
  const chats = new Map([
    // O cliente está na verde errada e também possui uma etiqueta manual.
    ['55111@c.us', new Set(['4', '50'])],
    ['novo@c.us', new Set()],
  ]);
  const unreadChats = new Set();
  const operations = [];

  function updateCounts() {
    for (const item of catalog) {
      item.count = [...chats.values()].filter((ids) => ids.has(String(item.id))).length;
    }
  }

  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() {
          updateCounts();
          return catalog;
        },
        async getLabelColorPalette() { return palette; },
        async addNewLabel() { throw new Error('addNewLabel não pode ser usado'); },
        async editLabel() { throw new Error('editLabel não pode ser usado'); },
      },
      lists: {
        async create(name, chatIds, colorIndex) {
          const id = String(nextId++);
          operations.push({ type: 'create', id, name, chatIds: [...chatIds], colorIndex });
          catalog.push({ id, name, colorIndex, count: 0 });
          for (const chatId of chatIds) chats.get(chatId)?.add(id);
          updateCounts();
          return id;
        },
        async remove(listId) {
          const id = String(listId);
          updateCounts();
          const item = catalog.find((candidate) => String(candidate.id) === id);
          if (!item) throw new Error(`List ${id} not found`);
          if (Number(item.count) > 0) throw new Error(`List ${id} still linked`);
          operations.push({ type: 'remove-list', listId: id });
          const index = catalog.findIndex((candidate) => String(candidate.id) === id);
          catalog.splice(index, 1);
          for (const ids of chats.values()) ids.delete(id);
          updateCounts();
        },
        async addChats(listId, chatIds) {
          const id = String(listId);
          operations.push({ type: 'add', listId: id, chatIds: [...chatIds] });
          if (!catalog.some((item) => String(item.id) === id)) {
            throw new Error(`List ${id} not found`);
          }
          for (const chatId of chatIds) {
            if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            chats.get(chatId).add(id);
          }
          updateCounts();
        },
        async removeChats(listId, chatIds) {
          const id = String(listId);
          operations.push({ type: 'remove-chat', listId: id, chatIds: [...chatIds] });
          for (const chatId of chatIds) chats.get(chatId)?.delete(id);
          updateCounts();
        },
      },
      chat: {
        async markIsUnread(chatId) {
          if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
          operations.push({ type: 'mark-unread', chatId });
          unreadChats.add(chatId);
          return { wid: chatId };
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
          return [...(chats.get(chat.id) || [])].map((id) => {
            const item = catalog.find((entry) => String(entry.id) === String(id));
            return item ? { ...item } : { id };
          });
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
  const channel = { client };

  try {
    ContactLabels.initializeTracking();
    ContactLabels.registerContact({ clientId: '55111@c.us', source: 'test' });

    const definitions = ServiceLabels.requiredLabelDefinitions();
    assert.deepStrictEqual(
      definitions.map((item) => item.name),
      ['Orçamento letreiros', 'Plotagens', 'Outros', 'Suporte'],
      'somente etiquetas operacionais devem fazer parte do catálogo textual',
    );

    const ensured = await ServiceLabels.ensureRequiredCatalog(channel);
    assert.strictEqual(ensured.ready, true, 'todas as etiquetas operacionais devem existir');
    assert.strictEqual(
      ensured.catalog['service:letreiro'].id,
      '9',
      'a canônica precisa ser escolhida por nome e cor, nunca apenas pelo nome',
    );
    assert.strictEqual(ensured.catalog['service:letreiro'].colorIndex, 5);
    assert.deepStrictEqual(ensured.catalog['service:letreiro'].duplicateIds, ['4']);
    assert.strictEqual(
      operations.some((item) => item.type === 'remove-list' && item.listId === '4'),
      false,
      'a verde não pode ser apagada antes de o cliente ser migrado',
    );

    const assignment = await ServiceLabels.assignSellerResponsibility(
      channel,
      '55111@c.us',
      'Adriano',
      { source: 'test-assignment' },
    );
    assert.strictEqual(assignment.assigned, true);
    assert.strictEqual(assignment.unreadMarked, true);

    const applied = await ServiceLabels.replaceServiceLabel(channel, '55111@c.us', 'letreiro');
    assert.strictEqual(applied.applied, true);
    assert.strictEqual(applied.verified, true);
    assert.strictEqual(applied.targetId, '9', 'o contato deve receber o ID roxo');
    assert.deepStrictEqual(applied.duplicateIdsRemoved, ['4']);

    const addPurpleIndex = operations.findIndex(
      (item) => item.type === 'add' && item.listId === '9',
    );
    const removeGreenFromChatIndex = operations.findIndex(
      (item) => item.type === 'remove-chat' && item.listId === '4',
    );
    assert.ok(addPurpleIndex >= 0, 'a roxa precisa ser aplicada');
    assert.ok(
      removeGreenFromChatIndex > addPurpleIndex,
      'a verde só pode sair depois de a roxa ser aplicada e confirmada',
    );

    assert.deepStrictEqual(
      [...chats.get('55111@c.us')].sort(),
      ['50', '9'],
      'a verde deve sair, a roxa deve ficar e a etiqueta manual deve ser preservada',
    );
    assert.strictEqual(
      catalog.some((item) => String(item.id) === '4'),
      false,
      'a duplicada verde só deve ser removida globalmente depois da migração confirmada',
    );
    assert.strictEqual(
      catalog.some((item) => String(item.id) === '9' && Number(item.colorIndex) === 5),
      true,
      'a canônica roxa deve permanecer no catálogo',
    );

    const persisted = JSON.parse(fs.readFileSync(TEST_STORE, 'utf8'));
    assert.strictEqual(
      persisted.catalog['service:letreiro'].id,
      '9',
      'o banco deve persistir o ID canônico roxo',
    );

    let stored = ContactLabels.getContact('55111@c.us');
    assert.strictEqual(stored.expected.operational.name, 'Orçamento letreiros');
    assert.strictEqual(stored.expected.operational.color, 'purple');
    assert.strictEqual(stored.expected.seller.name, 'Adriano');

    // Simula uma nova conexão: catálogo e vínculos operacionais somem, o banco permanece.
    catalog.splice(0, catalog.length, { id: '50', name: 'VIP', colorIndex: 4, count: 1 });
    chats.set('55111@c.us', new Set(['50']));
    unreadChats.clear();
    ServiceLabels._test.resetRuntimeAttentionMarks();

    const recovery = await ServiceLabels.reconcileTrackedContacts(channel);
    assert.strictEqual(recovery.catalogReady, true, 'catálogo deve ser recriado após reconexão');
    assert.strictEqual(recovery.reconciled, 1, 'etiqueta operacional deve ser restaurada pelo banco');
    assert.strictEqual(recovery.sellerAttentionMarked, 1, 'atenção do vendedor deve ser restaurada');

    const recreatedLetreiro = catalog.find((item) => item.name === 'Orçamento letreiros');
    assert.ok(recreatedLetreiro);
    assert.strictEqual(recreatedLetreiro.colorIndex, 5, 'etiqueta recriada deve continuar roxa');
    assert.deepStrictEqual(
      [...chats.get('55111@c.us')].sort(),
      ['50', recreatedLetreiro.id].sort(),
      'reconciliação deve restaurar a roxa sem remover a etiqueta manual',
    );

    ContactLabels.registerContact({ clientId: 'novo@c.us', source: 'test-pending' });
    const stats = ContactLabels.stats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.tagged, 1);
    assert.strictEqual(stats.pending, 1);
    assert.strictEqual(stats.sellerAssigned, 1);

    console.log('[TESTE ETIQUETAS] etapa 1: migração verde -> roxa canônica confirmada: OK');
  } finally {
    Identity.normalizeChatId = originals.normalizeChatId;
    Identity.getLabelCandidateIds = originals.getLabelCandidateIds;
    Identity.getSessionKey = originals.getSessionKey;
    Identity.resolveContact = originals.resolveContact;
    try { fs.unlinkSync(TEST_STORE); } catch (_) {}
    try { fs.unlinkSync(`${TEST_STORE}.tmp`); } catch (_) {}
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
