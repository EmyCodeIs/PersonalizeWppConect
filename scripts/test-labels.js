'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEST_STORE = path.join('data', 'contact-labels.test.json');
process.env.CONTACT_LABEL_STORE_PATH = TEST_STORE;
process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_LETREIRO_COLOR = 'purple';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_PLOTAGEM_COLOR = 'gray';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_OUTROS_COLOR = 'red';
process.env.SUPPORT_LABEL_NAME = 'Suporte';
process.env.SUPPORT_LABEL_COLOR = 'red';
process.env.SELLER_NAMES = 'Adriano;Aninha;Carlos';
process.env.MARK_SELLER_CLIENT_UNREAD = 'true';
process.env.RECREATE_MISMATCHED_OPERATIONAL_LABELS = 'true';
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
    // Simula a configuração errada anterior: mesma etiqueta criada em verde.
    { id: '4', name: 'Orçamento letreiros', colorIndex: 1, count: 0 },
  ];
  const chats = new Map([
    ['55111@c.us', new Set()],
    ['novo@c.us', new Set()],
  ]);
  const unreadChats = new Set();
  const operations = [];

  const browserWindow = {
    WPP: {
      labels: {
        async getAllLabels() { return catalog; },
        async getLabelColorPalette() { return palette; },
        async addNewLabel() { throw new Error('addNewLabel não pode ser usado'); },
        async editLabel() { throw new Error('editLabel não pode ser usado'); },
      },
      lists: {
        async create(name, chatIds, colorIndex) {
          const id = String(nextId++);
          operations.push({ type: 'create', id, name, chatIds: [...chatIds], colorIndex });
          catalog.push({ id, name, colorIndex, count: 0 });
          return id;
        },
        async remove(listId) {
          operations.push({ type: 'remove-list', listId: String(listId) });
          const index = catalog.findIndex((item) => String(item.id) === String(listId));
          if (index < 0) throw new Error(`List ${listId} not found`);
          catalog.splice(index, 1);
          for (const ids of chats.values()) ids.delete(String(listId));
        },
        async addChats(listId, chatIds) {
          operations.push({ type: 'add', listId: String(listId), chatIds: [...chatIds] });
          if (!catalog.some((item) => String(item.id) === String(listId))) {
            throw new Error(`List ${listId} not found`);
          }
          for (const chatId of chatIds) {
            if (!chats.has(chatId)) throw new Error(`Chat ${chatId} not found`);
            chats.get(chatId).add(String(listId));
          }
        },
        async removeChats(listId, chatIds) {
          operations.push({ type: 'remove-chat', listId: String(listId), chatIds: [...chatIds] });
          for (const chatId of chatIds) chats.get(chatId)?.delete(String(listId));
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
    assert.strictEqual(
      definitions.some((item) => ['Adriano', 'Aninha', 'Carlos'].includes(item.name)),
      false,
      'vendedores não podem ser criados como etiquetas textuais',
    );

    const ensured = await ServiceLabels.ensureRequiredCatalog(channel);
    assert.strictEqual(ensured.ready, true, 'todas as etiquetas operacionais devem existir');

    const letreiro = catalog.find((item) => item.name === 'Orçamento letreiros');
    assert.ok(letreiro, 'Orçamento letreiros deve existir');
    assert.strictEqual(letreiro.colorIndex, 5, 'Orçamento letreiros deve ser recriada em roxo');
    assert.strictEqual(
      operations.some((item) => item.type === 'remove-list' && item.listId === '4'),
      true,
      'a versão verde criada anteriormente deve ser substituída',
    );
    assert.strictEqual(
      operations.some((item) => item.type === 'create' && item.name === 'Adriano'),
      false,
      'o catálogo não deve criar etiqueta de vendedor',
    );

    const assignment = await ServiceLabels.assignSellerResponsibility(
      channel,
      '55111@c.us',
      'Adriano',
      { source: 'test-assignment' },
    );
    assert.strictEqual(assignment.assigned, true);
    assert.strictEqual(assignment.unreadMarked, true, 'cliente do vendedor deve ganhar a bolinha de não lido');
    assert.strictEqual(unreadChats.has('55111@c.us'), true);

    let stored = ContactLabels.getContact('55111@c.us');
    assert.strictEqual(stored.expected.seller.name, 'Adriano', 'vendedor deve ficar salvo no banco');
    assert.strictEqual(stored.attention.needsAttention, true);
    assert.strictEqual(stored.expected.operational, null, 'cliente ainda não classificado fica pendente');

    const applied = await ServiceLabels.replaceServiceLabel(channel, '55111@c.us', 'letreiro');
    assert.strictEqual(applied.applied, true);
    stored = ContactLabels.getContact('55111@c.us');
    assert.strictEqual(stored.expected.operational.name, 'Orçamento letreiros');
    assert.strictEqual(stored.expected.operational.color, 'purple');
    assert.strictEqual(stored.expected.seller.name, 'Adriano');

    const firstLetreiroId = catalog.find((item) => item.name === 'Orçamento letreiros').id;
    assert.deepStrictEqual(
      [...chats.get('55111@c.us')],
      [firstLetreiroId],
      'cliente deve receber somente a etiqueta textual operacional; vendedor fica no banco',
    );

    // Simula uma nova conexão: catálogo e vínculos somem, mas o banco permanece.
    catalog.splice(0, catalog.length);
    chats.set('55111@c.us', new Set());
    unreadChats.clear();
    ServiceLabels._test.resetRuntimeAttentionMarks();

    const recovery = await ServiceLabels.reconcileTrackedContacts(channel);
    assert.strictEqual(recovery.catalogReady, true, 'catálogo deve ser recriado após reconexão');
    assert.strictEqual(recovery.reconciled, 1, 'etiqueta operacional deve ser restaurada pelo banco');
    assert.strictEqual(recovery.sellerAttentionMarked, 1, 'bolinha do vendedor deve ser restaurada uma vez');

    const recreatedLetreiro = catalog.find((item) => item.name === 'Orçamento letreiros');
    assert.ok(recreatedLetreiro);
    assert.strictEqual(recreatedLetreiro.colorIndex, 5, 'etiqueta recriada deve continuar roxa');
    assert.deepStrictEqual(
      [...chats.get('55111@c.us')],
      [recreatedLetreiro.id],
      'reconciliação não pode criar nem aplicar etiqueta textual de vendedor',
    );
    assert.strictEqual(unreadChats.has('55111@c.us'), true, 'conversa atribuída deve voltar como não lida');

    ContactLabels.registerContact({ clientId: 'novo@c.us', source: 'test-pending' });
    const stats = ContactLabels.stats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.tagged, 1);
    assert.strictEqual(stats.pending, 1, 'novo cliente sem escolha deve ficar pendente');
    assert.strictEqual(stats.sellerAssigned, 1);
    assert.strictEqual(stats.needsAttention, 1);

    console.log('[TESTE ETIQUETAS] texto roxo, vendedor no banco e bolinha de não lido: OK');
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
