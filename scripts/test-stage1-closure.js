'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SESSION_FILE = path.join('data', 'sessions.stage1-closure.test.json');
const LEAD_FILE = path.join('data', 'leads.stage1-closure.test.jsonl');
const IDENTITY_FILE = path.join('data', 'identities.stage1-closure.test.json');
const LABEL_FILE = path.join('data', 'contact-labels.stage1-closure.test.json');
process.env.SESSIONS_STORE_PATH = SESSION_FILE;
process.env.LEADS_STORE_PATH = LEAD_FILE;
process.env.CONTACT_IDENTITIES_STORE_PATH = IDENTITY_FILE;
process.env.CONTACT_LABEL_STORE_PATH = LABEL_FILE;
process.env.ORDER_NUMBER_START = '70005';
process.env.BOT_REENTRY_AFTER_HOURS = '72';
process.env.DETECT_MANUAL_SELLER_MESSAGES = 'true';
process.env.ENABLE_TEST_COMMANDS = 'true';

const TEST_FILES = [
  SESSION_FILE,
  `${SESSION_FILE}.tmp`,
  LEAD_FILE,
  IDENTITY_FILE,
  `${IDENTITY_FILE}.tmp`,
  LABEL_FILE,
  `${LABEL_FILE}.tmp`,
];
for (const file of TEST_FILES) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const Identity = require('../src/services/contactIdentity');
const Store = require('../src/services/leadStore');
const ContactLabels = require('../src/services/contactLabelStore');
const ConversationControl = require('../src/services/conversationControl');
const SystemReset = require('../src/services/systemReset');
const {
  sanitizeBusinessNote,
  getMessageText,
} = require('../src/services/wppconnectClient');
const {
  OutboundMessageTracker,
} = require('../src/services/outboundMessageTracker');
const { messages } = require('../src/core/messages');
const { buildBusinessNote } = require('../src/flow/customerFlow');

function testCleanMediaNotes() {
  const huge = 'A'.repeat(5000);
  const note = [
    '📋 *Dados do pedido* (#70005)',
    '👤 Cliente: Emy',
    `• Descrição da arte: ${huge}`,
    'Arquivos/referências recebidos: image: codigo-enorme.jpeg',
    '📍 Cidade: Belo Horizonte/MG',
  ].join('\n');

  const sanitized = sanitizeBusinessNote(note);
  assert.strictEqual(sanitized.includes(huge), false, 'a nota não pode guardar carga codificada da imagem');
  assert.strictEqual(
    sanitized.split('\n').filter((line) => line === 'Arquivo de arte na conversa').length,
    1,
    'a nota deve ter uma única indicação simples do arquivo',
  );
  assert.strictEqual(sanitized.includes('Arquivos/referências recebidos:'), false);

  assert.strictEqual(
    getMessageText({ type: 'image', body: huge, caption: '' }),
    '',
    'body técnico de imagem não pode entrar no fluxo',
  );
  assert.strictEqual(
    getMessageText({ type: 'image', body: huge, caption: 'Logo em anexo' }),
    'Logo em anexo',
    'legenda real da imagem deve ser preservada',
  );
}

function testSellerStyleNote() {
  const note = buildBusinessNote({
    chatId: '553186915950@c.us',
    contactIdentity: { phone: '553186915950', cUsId: '553186915950@c.us' },
    dados: {
      pedidoNumero: 70005,
      nome: 'Ana',
      telefone: '553186915950',
      cidade: 'belo horizonte',
      origem: 'landing/site',
      envio: 'Correios',
      endereco: 'Rua Américo diamantino 90\nSala 303\nBairro Cruzeiro (Não sei o cep)',
      flow: 'letreiro',
      tipoAcrilico: 'colorido',
      tipoCor: 'prontas',
      coresSelecionadas: ['Preto', 'Branco'],
      medida: { largura: 30, altura: 30 },
      tamanhoModo: 'completo',
      espessuraBaseLabel: '3mm',
      espessuraBaseDescricao: '🔎 Observação: as cores Preto e Branco possuem espessura padrão de 3mm.',
      arteMedias: [{ type: 'image' }],
      observacaoPedido: 'Gostaria que fosse uma placa branca de acrílico como a da foto de referência com os escritos em acrílico preto em alto relevo\n\nGostaria de saber tbm se vcs trabalham com o dourado fosco, sem ser o espelhado',
    },
  });

  assert.strictEqual(note.startsWith('📋 *Dados do pedido* (#70005)'), true);
  assert.strictEqual(note.includes('👤 Cliente: Ana'), true);
  assert.strictEqual(note.includes('📱 Telefone: 553186915950'), true);
  assert.strictEqual(note.includes('🌐 Origem: LandingPage'), true);
  assert.strictEqual(note.includes('🚚 Envio: *Correios*'), true);
  assert.strictEqual(note.includes('*Letreiro*'), true);
  assert.strictEqual(note.includes('• Medida: 30cm × 30cm'), true);
  assert.strictEqual(note.includes('• Cor: Preto, Branco (prontas)'), true);
  assert.strictEqual(note.includes('• Espessura base: 3mm'), true);
  assert.strictEqual(note.includes('• as cores Preto e Branco possuem espessura padrão de 3mm.'), true);
  assert.strictEqual(note.includes('Arquivo de arte na conversa'), true);
  assert.strictEqual(note.includes('📝 *Observação do cliente:*'), true);
  assert.strictEqual(/Atendimento coletado|Status:|Atualizado em:/i.test(note), false);
}

function testSequentialOrderNumbers() {
  const firstSession = Store.resetSession('5531991111111@c.us');
  const firstNumber = Store.ensureOrderNumber(firstSession);
  assert.strictEqual(firstNumber, 70005);
  assert.strictEqual(Store.ensureOrderNumber(firstSession), 70005, 'a mesma sessão deve manter o número');

  const secondSession = Store.resetSession('5531992222222@c.us');
  assert.strictEqual(Store.ensureOrderNumber(secondSession), 70006);
}

function testObservationCopy() {
  assert.strictEqual(
    messages.askObservationText,
    'Claro! Me conte o que gostaria de acrescentar ao pedido.',
  );
  assert.strictEqual(/segundos|juntar tudo|técnic/i.test(messages.askObservationText), false);
}

function testOutboundTracker() {
  const tracker = new OutboundMessageTracker({ ttlMs: 45000 });
  tracker.begin({
    chatId: '5531999999999@c.us',
    kind: 'text',
    texts: ['Mensagem automática do bot'],
  });

  assert.strictEqual(
    tracker.consume({
      fromMe: true,
      to: '5531999999999@c.us',
      type: 'chat',
      body: 'Mensagem automática do bot',
    }),
    true,
    'mensagem registrada pelo bot precisa ser reconhecida',
  );

  assert.strictEqual(
    tracker.consume({
      fromMe: true,
      to: '5531999999999@c.us',
      type: 'chat',
      body: 'Olá, aqui é o vendedor. Vou assumir seu atendimento.',
    }),
    false,
    'mensagem manual diferente não pode ser confundida com o bot',
  );

  tracker.begin({
    chatId: '5531999999999@c.us',
    kind: 'list',
    texts: ['Selecione uma opção'],
  });
  assert.strictEqual(
    tracker.consume({
      fromMe: true,
      to: '5531999999999@c.us',
      type: 'chat',
      body: 'Conteúdo serializado diferente da lista',
    }),
    true,
    'lista enviada pelo bot não pode acionar handoff por diferença de serialização',
  );
}

function testOutgoingIdentity() {
  const customer = '5531997777777@c.us';
  const ownNumber = '5531990000000@c.us';
  const identity = Identity.registerContact({
    chatId: customer,
    raw: {
      fromMe: true,
      from: ownNumber,
      to: customer,
      chatId: customer,
      id: { remote: customer },
    },
  });

  assert.strictEqual(identity.primaryChatId, customer);
  assert.strictEqual(identity.aliases.includes(customer), true);
  assert.strictEqual(
    identity.aliases.includes(ownNumber),
    false,
    'o número da própria empresa não pode virar alias do cliente',
  );
}

function testSellerTakeoverAndReentry() {
  const clientId = '5531999999911@c.us';
  const start = Date.parse('2026-07-13T12:00:00.000Z');
  const session = Store.resetSession(clientId);
  session.etapa = 'tamanho';
  session.dados.nome = 'Emy';
  Store.saveSession(session);

  const taken = ConversationControl.beginSellerTakeover(clientId, {
    at: start,
    messageId: 'seller-msg-1',
    text: 'Vou assumir por aqui.',
  });
  assert.strictEqual(taken.dados.humanTakeover.active, true);
  assert.strictEqual(taken.dados.botControl.reason, 'seller_message');
  assert.strictEqual(
    taken.dados.botControl.silenceUntil,
    '2026-07-16T12:00:00.000Z',
  );

  const during = ConversationControl.evaluateIncoming(clientId, {
    at: start + (2 * 60 * 60 * 1000),
    text: 'Obrigada!',
  });
  assert.strictEqual(during.action, 'ignore', 'bot deve ficar silencioso durante as 72h');
  assert.strictEqual(ConversationControl.shouldBlockBotOutbound(clientId, start + 1000), true);

  const after = ConversationControl.evaluateIncoming(clientId, {
    at: start + (73 * 60 * 60 * 1000),
    text: 'Olá, gostaria de um novo orçamento',
  });
  assert.strictEqual(after.action, 'process');
  assert.strictEqual(after.reset, true, 'primeiro contato após 72h deve iniciar novo atendimento');

  const reopened = Store.getSession(clientId);
  assert.strictEqual(reopened.etapa, 'inicio');
  assert.strictEqual(reopened.completed, false);
  assert.strictEqual(reopened.dados.nome, 'Emy', 'nome básico deve ser preservado no novo atendimento');
  assert.strictEqual(reopened.dados.humanTakeover, undefined);
}

function testCompletionSilence() {
  const clientId = '5531999999922@c.us';
  const completedAt = '2026-07-13T15:00:00.000Z';
  const session = Store.resetSession(clientId);
  session.etapa = 'concluido';
  session.completed = true;
  session.dados.botDone = true;
  session.dados.completedAt = completedAt;
  Store.saveSession(session);

  const saved = ConversationControl.ensureCompletionSilence(clientId);
  assert.strictEqual(saved.dados.botControl.reason, 'completed');
  assert.strictEqual(saved.dados.botControl.silenceUntil, '2026-07-16T15:00:00.000Z');

  const during = ConversationControl.evaluateIncoming(clientId, {
    at: Date.parse('2026-07-15T15:00:00.000Z'),
    text: 'Tenho outra dúvida',
  });
  assert.strictEqual(during.action, 'ignore');

  const after = ConversationControl.evaluateIncoming(clientId, {
    at: Date.parse('2026-07-16T16:00:00.000Z'),
    text: 'Quero fazer um novo pedido',
  });
  assert.strictEqual(after.action, 'process');
  assert.strictEqual(after.reset, true);
}

function createPageEvaluator(windowObject) {
  return {
    async evaluate(fn, args) {
      const previousWindow = global.window;
      global.window = windowObject;
      try {
        return await fn(args);
      } finally {
        global.window = previousWindow;
      }
    },
  };
}

async function testRealLabelRemovalAPI() {
  const clientId = '5531993333333@c.us';
  const catalog = [
    { id: '9', name: 'Orçamento letreiros' },
    { id: '10', name: 'Plotagens' },
    { id: '50', name: 'VIP' },
  ];
  const chat = {
    id: { _serialized: clientId, toJid: () => clientId },
    labels: ['9', '50'],
  };
  const windowObject = {
    WPP: {
      labels: {
        async getAllLabels() { return catalog; },
        async addOrRemoveLabels(chatId, options) {
          assert.strictEqual(chatId, clientId);
          for (const option of options) {
            if (option.type === 'remove') {
              chat.labels = chat.labels.filter((id) => String(id) !== String(option.labelId));
            }
          }
          return true;
        },
      },
    },
    Store: {
      Chat: {
        get(id) { return id === clientId ? chat : null; },
        async find(id) { return id === clientId ? chat : null; },
      },
      Label: {
        getLabelsForModel(model) {
          return model.labels.map((id) => catalog.find((item) => item.id === id) || { id });
        },
      },
    },
  };

  const result = await SystemReset.removeManagedLabelsFromContact(
    { client: { page: createPageEvaluator(windowObject) } },
    { clientId, aliases: [clientId] },
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.removedIds.includes('9'), true);
  assert.deepStrictEqual(chat.labels, ['50'], 'etiqueta manual deve ser preservada');
}

async function testRealNoteDeletionAPI() {
  const clientId = '5531994444444@c.us';
  let note = {
    id: 'note-1',
    type: 'unstructured',
    chatJid: clientId,
    content: 'Dados antigos',
    createdAt: 100,
    modifiedAt: 100,
  };
  const chat = { id: { _serialized: clientId, toJid: () => clientId } };
  let deletionMutation = null;

  const modules = {
    WAWebNoteAction: {
      async retrieveOnlyNoteForChatJid() { return note; },
    },
    WAWebNoteSync: {
      collectionName: 'regular_low',
      getAction() { return 'note_edit'; },
      getVersion() { return 7; },
      async resolveNoteId(_source, _target, id) { return id; },
    },
    WAWebSyncdGetChat: {
      async getChatJidMutationIndexForChat(id) { return id; },
    },
    WAWebWidFactory: { createWid(id) { return id; } },
    WAWebWidToJid: { widToChatJid(id) { return id; } },
    WAWebSyncdActionUtils: {
      buildPendingMutation(args) {
        deletionMutation = args;
        return args;
      },
    },
    'WAWebProtobufsServerSync.pb': {
      SyncdMutation$SyncdOperation: { SET: 1 },
    },
    WAWebSyncdCoreApi: {
      async lockForSync(_collections, _mutations, callback) { await callback(); },
    },
    WAWebSchemaNote: {
      getNoteTable() {
        return {
          async remove(id) {
            if (String(note?.id) === String(id)) note = null;
          },
        };
      },
    },
    WAWebNoteCollection: {
      NoteCollection: { purgeNotesByChatJid() {} },
    },
  };

  const windowObject = {
    WPP: {
      chat: {
        async getNotes() { return note; },
        async setNotes(_id, content) {
          note = { ...(note || {}), id: 'note-fallback', chatJid: clientId, content };
          return note;
        },
      },
    },
    Store: {
      Chat: {
        get(id) { return id === clientId ? chat : null; },
        async find(id) { return id === clientId ? chat : null; },
      },
    },
    require(name) {
      if (!(name in modules)) throw new Error(`Módulo ausente: ${name}`);
      return modules[name];
    },
  };

  const result = await SystemReset.clearContactNote(
    { client: { page: createPageEvaluator(windowObject) } },
    clientId,
    { clientId, aliases: [clientId] },
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.mode, 'deleted');
  assert.strictEqual(note, null);
  assert.strictEqual(deletionMutation.value.noteEditAction.deleted, true);
}

async function testSystemResetCleansWhatsAppData() {
  const clientId = '5531999999933@c.us';
  const session = Store.resetSession(clientId);
  session.etapa = 'concluido';
  session.dados.nome = 'Cliente Reset';
  Store.saveSession(session);

  ContactLabels.registerContact({ clientId, source: 'test-reset' });
  ContactLabels.setExpectedLabel(clientId, {
    key: 'service:letreiro',
    name: 'Orçamento letreiros',
    color: 'purple',
    kind: 'service',
    role: 'operational',
    service: 'letreiro',
  }, { source: 'test-reset' });

  const removedFor = [];
  const notesClearedFor = [];
  const result = await SystemReset.resetSystemWithWhatsAppCleanup({
    channel: {},
    removeLabels: async (_channel, target) => {
      removedFor.push(target.clientId);
      return { success: true, removedIds: ['9'], chatId: target.clientId, verified: true };
    },
    clearNote: async (_channel, targetClientId) => {
      notesClearedFor.push(targetClientId);
      return { success: true, mode: 'deleted' };
    },
  });

  assert.strictEqual(result.cleanupFailures, 0);
  assert.strictEqual(result.labelsRemoved >= 1, true);
  assert.strictEqual(result.notesCleared >= 1, true);
  assert.strictEqual(removedFor.includes(clientId), true);
  assert.strictEqual(notesClearedFor.includes(clientId), true);
  assert.strictEqual(ContactLabels.stats().total, 0, 'banco de contatos precisa ser limpo');
  assert.strictEqual(Store.listSessions().length, 0, 'sessões precisam ser apagadas');
}

async function run() {
  try {
    testCleanMediaNotes();
    testSellerStyleNote();
    testSequentialOrderNumbers();
    testObservationCopy();
    testOutboundTracker();
    testOutgoingIdentity();
    testSellerTakeoverAndReentry();
    testCompletionSilence();
    await testRealLabelRemovalAPI();
    await testRealNoteDeletionAPI();
    await testSystemResetCleansWhatsAppData();
    console.log('[TESTE FECHAMENTO ETAPA 1] reset real, nota de vendedor, silêncio 72h e handoff: OK');
  } finally {
    for (const file of TEST_FILES) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
