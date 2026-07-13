'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SESSION_FILE = path.join('data', 'sessions.preprod-adjustments.test.json');
const LEAD_FILE = path.join('data', 'leads.preprod-adjustments.test.jsonl');
const IDENTITY_FILE = path.join('data', 'identities.preprod-adjustments.test.json');
const LABEL_FILE = path.join('data', 'contact-labels.preprod-adjustments.test.json');

process.env.SESSIONS_STORE_PATH = SESSION_FILE;
process.env.LEADS_STORE_PATH = LEAD_FILE;
process.env.CONTACT_IDENTITIES_STORE_PATH = IDENTITY_FILE;
process.env.CONTACT_LABEL_STORE_PATH = LABEL_FILE;
process.env.ORDER_NUMBER_START = '70001';
process.env.ENABLE_TYPING = 'true';
process.env.TYPING_MIN_MS = '0';
process.env.TYPING_MAX_MS = '0';
process.env.TYPING_CHARS_PER_SECOND = '9999';
process.env.MARK_SELLER_CLIENT_UNREAD = 'true';
process.env.BOT_REENTRY_AFTER_HOURS = '72';
process.env.ENABLE_CONTACT_NOTES = 'true';

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

const { menus } = require('../src/core/menuCatalog');
const { messages } = require('../src/core/messages');
const { BufferManager } = require('../src/core/bufferManager');
const { installMessageExperience } = require('../src/core/messageExperience');
const Store = require('../src/services/leadStore');
const ContactLabels = require('../src/services/contactLabelStore');

function createPageEvaluator(windowObject) {
  return {
    async evaluate(fn, args) {
      const previous = global.window;
      global.window = windowObject;
      try {
        return await fn(args);
      } finally {
        global.window = previous;
      }
    },
  };
}

function createChannel(clientIds = []) {
  const events = [];
  const notes = new Map();
  const unread = new Set();
  const chats = new Map(clientIds.map((id) => [id, { id }]));

  const windowObject = {
    WPP: {
      chat: {
        async markIsUnread(chatId) {
          if (!chats.has(chatId)) throw new Error(`chat ausente: ${chatId}`);
          events.push(`unread:${chatId}`);
          unread.add(chatId);
          return { wid: chatId };
        },
      },
    },
    Store: {
      Chat: {
        get(id) { return chats.get(id) || null; },
        async find(id) { return chats.get(id) || null; },
      },
    },
  };

  const client = {
    async startTyping(chatId) { events.push(`typing:start:${chatId}`); },
    async stopTyping(chatId) { events.push(`typing:stop:${chatId}`); },
    async sendText(chatId, text) {
      events.push(`text:${chatId}:${text}`);
      return { id: `sent-${events.length}` };
    },
    page: createPageEvaluator(windowObject),
  };

  const channel = {
    client,
    async sendText(chatId, text) {
      return client.sendText(chatId, text);
    },
    async setContactNote(chatId, note) {
      events.push(`note:${chatId}`);
      notes.set(chatId, note);
      return true;
    },
  };

  installMessageExperience(channel);
  return { channel, events, notes, unread };
}

function testMenuDescriptionsAndPrompts() {
  const plotagem = menus.servicos.rows.find((row) => row.id === 'serv_plotagem');
  const outros = menus.servicos.rows.find((row) => row.id === 'serv_outros');

  assert.strictEqual(plotagem.description, 'Descreva a aplicação e envie referências');
  assert.strictEqual(outros.description, 'Descreva o produto ou serviço desejado');
  assert.strictEqual(/coletar dados/i.test(plotagem.description), false);
  assert.strictEqual(/coletar dados/i.test(outros.description), false);
  assert.strictEqual(/fotos ou vídeos de referência/i.test(messages.plotagem), true);
  assert.strictEqual(/fotos ou vídeos de referência/i.test(messages.otherService), true);
}

async function testImmediateResetCommand() {
  const startedAt = Date.now();
  let flushedAt = null;
  let flushedMessages = null;

  const finished = new Promise((resolve, reject) => {
    const buffer = new BufferManager({
      delayMs: 8000,
      onFlush: async (_clientId, items) => {
        flushedAt = Date.now();
        flushedMessages = items;
        resolve();
      },
    });

    buffer.push('5531990000001@c.us', { text: '/resetarsys' }, { delayMs: 8000 });
    setTimeout(() => reject(new Error('comando imediato continuou aguardando buffer')), 500);
  });

  await finished;
  assert.ok(flushedAt - startedAt < 400, 'resetarsys precisa ignorar o buffer de 8 segundos');
  assert.strictEqual(flushedMessages.length, 1);
  assert.strictEqual(flushedMessages[0].text, '/resetarsys');
}

async function testGroupedTypingBeforeMessages() {
  const clientId = '5531990000002@c.us';
  const { channel, events } = createChannel([clientId]);

  await channel.runResponseGroup(clientId, 'resposta agrupada', async () => {
    await channel.sendText(clientId, 'Primeiro balão');
    await channel.sendText(clientId, 'Segundo balão');
  });

  const startIndex = events.indexOf(`typing:start:${clientId}`);
  const stopIndex = events.indexOf(`typing:stop:${clientId}`);
  const firstIndex = events.indexOf(`text:${clientId}:Primeiro balão`);
  const secondIndex = events.indexOf(`text:${clientId}:Segundo balão`);

  assert.ok(startIndex >= 0, 'grupo precisa exibir digitando');
  assert.ok(stopIndex > startIndex, 'digitando precisa terminar depois de começar');
  assert.ok(firstIndex > stopIndex, 'primeiro balão deve sair depois do digitando');
  assert.ok(secondIndex > firstIndex, 'balões devem manter a ordem');
  assert.strictEqual(
    events.filter((event) => event === `typing:start:${clientId}`).length,
    1,
    'grupo deve mostrar digitando uma única vez',
  );
}

async function testPlotagemStopsAndMarksUnread() {
  const clientId = '5531990000003@c.us';
  const { channel, events, notes, unread } = createChannel([clientId]);
  ContactLabels.registerContact({ clientId, source: 'test-preprod' });

  const session = Store.resetSession(clientId);
  session.etapa = 'plotagem_medida';
  session.dados.flow = 'plotagem';
  session.dados.nome = 'Cliente Plotagem';
  session.dados.origem = 'whatsapp';
  session.dados.demanda = {
    descricao: 'Preciso plotar uma vitrine inteira\n[imagem enviada]',
  };
  Store.saveSession(session);

  const result = await channel.sendText(clientId, messages.askPlotagemMedida, { noTyping: true });
  const saved = Store.getSession(clientId);

  assert.ok(result, 'interceptação deve concluir o pré-atendimento');
  assert.strictEqual(saved.completed, true);
  assert.strictEqual(saved.etapa, 'concluido');
  assert.strictEqual(saved.dados.awaitingSeller, true);
  assert.strictEqual(saved.dados.demanda.descricao, 'Preciso plotar uma vitrine inteira');
  assert.strictEqual(saved.dados.demanda.referenciaNaConversa, true);
  assert.strictEqual(unread.has(clientId), true, 'conversa precisa ficar não lida para o vendedor');
  assert.strictEqual(
    events.some((event) => event.includes(messages.askPlotagemMedida)),
    false,
    'bot não pode fazer uma segunda pergunta após receber a demanda',
  );
  assert.strictEqual(notes.get(clientId).includes('*Plotagem*'), true);
  assert.strictEqual(notes.get(clientId).includes('Arquivo de referência na conversa'), true);
}

async function testOutrosStopsAndMarksUnread() {
  const clientId = '5531990000004@c.us';
  const { channel, events, notes, unread } = createChannel([clientId]);
  ContactLabels.registerContact({ clientId, source: 'test-preprod' });

  const session = Store.resetSession(clientId);
  session.etapa = 'outros_referencia';
  session.dados.flow = 'outros';
  session.dados.nome = 'Cliente Outros';
  session.dados.demanda = { descricao: 'Preciso de uma placa em ACM' };
  Store.saveSession(session);

  await channel.sendText(clientId, messages.askOtherReferencia, { noTyping: true });
  const saved = Store.getSession(clientId);

  assert.strictEqual(saved.completed, true);
  assert.strictEqual(saved.dados.awaitingSeller, true);
  assert.strictEqual(unread.has(clientId), true);
  assert.strictEqual(
    events.some((event) => event.includes(messages.askOtherReferencia)),
    false,
    'bot não pode continuar perguntando após receber a demanda de Outros',
  );
  assert.strictEqual(notes.get(clientId).includes('*Outros serviços*'), true);
}

async function testLetreiroCompletionMarksUnreadAfterReply() {
  const clientId = '5531990000005@c.us';
  const { channel, events, unread } = createChannel([clientId]);
  ContactLabels.registerContact({ clientId, source: 'test-preprod' });

  const session = Store.resetSession(clientId);
  session.etapa = 'concluido';
  session.completed = true;
  session.dados.botDone = true;
  Store.saveSession(session);

  await channel.sendText(clientId, messages.completedContactNote, { noTyping: true });

  const textIndex = events.indexOf(`text:${clientId}:${messages.completedContactNote}`);
  const unreadIndex = events.indexOf(`unread:${clientId}`);
  assert.ok(textIndex >= 0);
  assert.ok(unreadIndex > textIndex, 'a conversa deve ser marcada não lida depois da resposta final');
  assert.strictEqual(unread.has(clientId), true);
}

async function run() {
  try {
    testMenuDescriptionsAndPrompts();
    await testImmediateResetCommand();
    await testGroupedTypingBeforeMessages();
    await testPlotagemStopsAndMarksUnread();
    await testOutrosStopsAndMarksUnread();
    await testLetreiroCompletionMarksUnreadAfterReply();
    console.log('[TESTE PRÉ-PRODUÇÃO] fluxos curtos, não lida, digitando em grupo e reset imediato: OK');
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
