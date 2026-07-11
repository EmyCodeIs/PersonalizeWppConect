'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEST_STORE = path.join('data', 'contact-labels.test.json');
process.env.CONTACT_LABEL_STORE_PATH = TEST_STORE;
process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_LETREIRO_COLOR = 'green';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_PLOTAGEM_COLOR = 'gray';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_OUTROS_COLOR = 'red';
process.env.SUPPORT_LABEL_NAME = 'Suporte';
process.env.SUPPORT_LABEL_COLOR = 'red';
process.env.SELLER_LABELS = 'Adriano|green;Aninha|blue;Carlos|yellow';
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
  Identity.getSessionKey = (value) => String(value) === 'novo@c.us' ? 'wa:new-contact' : 'wa:test-contact';
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

  const palette = ['#ea0038', '#00a884', '#667781', '#027eb5', '#f7b928'];
  let nextId = 20;
  const catalog = [
    { id: '5', name: 'Adriano', colorIndex: 1, count: 1 },
  ];
  const chats = new Map([
    ['55111@c.us', new Set(['5'])],
  ]);
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
          operations.push({ type: 'remove', listId: String(listId), chatIds: [...chatIds] });
          for (const chatId of chatIds) chats.get(chatId)?.delete(String(listId));
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

    const ensured = await ServiceLabels.ensureRequiredCatalog(channel);
    assert.strictEqual(ensured.ready, true, 'todas as etiquetas obrigatórias devem existir');
    assert.strictEqual(
      ServiceLabels.requiredLabelDefinitions().every((definition) => (
        catalog.some((item) => item.name === definition.name)
      )),
      true,
      'orçamento, plotagens, outros, suporte e vendedores devem existir',
    );
    assert.strictEqual(
      operations.some((item) => item.type === 'create' && item.name === 'Suporte'),
      true,
      'Suporte deve ser criado quando estiver ausente',
    );

    await ServiceLabels.observeContactLabels(channel, '55111@c.us', { force: true, source: 'mobile' });
    let stored = ContactLabels.getContact('55111@c.us');
    assert.strictEqual(stored.expected.seller.name, 'Adriano', 'vendedor observado deve ser salvo no banco');
    assert.strictEqual(stored.expected.operational, null, 'cliente ainda não classificado fica pendente');

    const applied = await ServiceLabels.replaceServiceLabel(channel, '55111@c.us', 'letreiro');
    assert.strictEqual(applied.applied, true);
    stored = ContactLabels.getContact('55111@c.us');
    assert.strictEqual(stored.expected.operational.name, 'Orçamento letreiros');
    assert.strictEqual(stored.expected.seller.name, 'Adriano');

    const firstIds = new Map(catalog.map((item) => [item.name, item.id]));
    assert.deepStrictEqual(
      [...chats.get('55111@c.us')].sort(),
      [firstIds.get('Adriano'), firstIds.get('Orçamento letreiros')].sort(),
      'cliente deve manter vendedor e receber etiqueta operacional',
    );

    // Simula nova conexão: o WhatsApp Web perde catálogo e vínculos, mas o banco local permanece.
    catalog.splice(0, catalog.length);
    chats.set('55111@c.us', new Set());

    const recovery = await ServiceLabels.reconcileTrackedContacts(channel);
    assert.strictEqual(recovery.catalogReady, true, 'catálogo deve ser recriado após reconexão');
    assert.strictEqual(recovery.reconciled, 1, 'cliente deve ser restaurado pelo banco');

    const recreatedByName = new Map(catalog.map((item) => [item.name, item.id]));
    assert.deepStrictEqual(
      [...chats.get('55111@c.us')].sort(),
      [recreatedByName.get('Adriano'), recreatedByName.get('Orçamento letreiros')].sort(),
      'reconciliação deve reaplicar serviço e vendedor usando os novos IDs',
    );

    assert.strictEqual(
      operations.some((item) => item.type === 'create' && item.name === 'Orçamento letreiros'),
      true,
      'lista operacional deve ser recriada por WPP.lists.create',
    );
    assert.strictEqual(
      operations.some((item) => item.type === 'add' && item.listId === recreatedByName.get('Adriano')),
      true,
      'etiqueta do vendedor deve ser restaurada',
    );

    ContactLabels.registerContact({ clientId: 'novo@c.us', source: 'test-pending' });
    const stats = ContactLabels.stats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.tagged, 1);
    assert.strictEqual(stats.pending, 1, 'novo cliente sem escolha deve ficar pendente, não desaparecer');

    console.log('[TESTE ETIQUETAS] catálogo obrigatório, banco por cliente e restauração após reconexão: OK');
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
