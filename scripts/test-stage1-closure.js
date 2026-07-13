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

function testCleanMediaNotes() {
  const huge = 'A'.repeat(5000);
  const note = [
    '🟢 Atendimento coletado pelo Bot WPPConnect',
    'Nome: Emy',
    `Descrição da arte: ${huge}`,
    'Arquivos/referências recebidos: image: codigo-enorme.jpeg',
    'Cidade: Belo Horizonte/MG',
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
      return { success: true };
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
    testObservationCopy();
    testOutboundTracker();
    testOutgoingIdentity();
    testSellerTakeoverAndReentry();
    testCompletionSilence();
    await testSystemResetCleansWhatsAppData();
    console.log('[TESTE FECHAMENTO ETAPA 1] silêncio 72h, handoff, nota limpa e resetarsys: OK');
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
