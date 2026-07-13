'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SESSION_FILE = path.join('data', 'sessions.reset-bypass.test.json');
const LEAD_FILE = path.join('data', 'leads.reset-bypass.test.jsonl');
const IDENTITY_FILE = path.join('data', 'identities.reset-bypass.test.json');

process.env.SESSIONS_STORE_PATH = SESSION_FILE;
process.env.LEADS_STORE_PATH = LEAD_FILE;
process.env.CONTACT_IDENTITIES_STORE_PATH = IDENTITY_FILE;
process.env.ENABLE_TEST_COMMANDS = 'true';
process.env.BOT_REENTRY_AFTER_HOURS = '72';

const TEST_FILES = [
  SESSION_FILE,
  `${SESSION_FILE}.tmp`,
  LEAD_FILE,
  IDENTITY_FILE,
  `${IDENTITY_FILE}.tmp`,
];

for (const file of TEST_FILES) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const Store = require('../src/services/leadStore');
const ConversationControl = require('../src/services/conversationControl');

function createHumanTakeover(clientId, at) {
  const session = Store.resetSession(clientId);
  session.etapa = 'tipo_acrilico';
  session.dados.nome = 'Cliente Teste';
  Store.saveSession(session);

  ConversationControl.beginSellerTakeover(clientId, {
    at,
    messageId: 'SELLER-TEST-1',
    text: 'Vou assumir o atendimento.',
  });
}

function testResetarsysBypassesHumanHandoff() {
  const clientId = '18885055098907@lid';
  const start = Date.parse('2026-07-13T18:00:00.000Z');
  createHumanTakeover(clientId, start);

  assert.strictEqual(
    ConversationControl.shouldBlockBotOutbound(clientId, start + 1),
    true,
    'handoff humano precisa bloquear mensagens comuns do bot',
  );

  const ordinary = ConversationControl.evaluateIncoming(clientId, {
    at: start + 100,
    text: 'Olá',
  });
  assert.strictEqual(ordinary.action, 'ignore', 'mensagem comum continua bloqueada pelo handoff');

  const resetCommand = ConversationControl.evaluateIncoming(clientId, {
    at: start + 200,
    text: '/resetarsys',
  });

  assert.strictEqual(resetCommand.action, 'process');
  assert.strictEqual(resetCommand.reason, 'test_command');
  assert.strictEqual(resetCommand.bypassSilence, true);
  assert.strictEqual(
    ConversationControl.shouldBlockBotOutbound(clientId, start + 201),
    false,
    '/resetarsys nunca pode ser descartado pelo silêncio do handoff',
  );

  // Sem executar o reset, a exceção expira e o handoff volta a bloquear.
  assert.strictEqual(
    ConversationControl.shouldBlockBotOutbound(
      clientId,
      start + 200 + ConversationControl._test.COMMAND_BYPASS_MS + 1,
    ),
    true,
    'a exceção do comando precisa ser temporária',
  );
}

function testReiniciarAlsoBypassesHumanHandoff() {
  const clientId = '5531999999911@c.us';
  const start = Date.parse('2026-07-13T19:00:00.000Z');
  createHumanTakeover(clientId, start);

  const command = ConversationControl.evaluateIncoming(clientId, {
    at: start + 100,
    text: '/reiniciar',
  });

  assert.strictEqual(command.action, 'process');
  assert.strictEqual(command.bypassSilence, true);
  assert.strictEqual(
    ConversationControl.shouldBlockBotOutbound(clientId, start + 101),
    false,
    '/reiniciar também precisa atravessar o handoff durante testes',
  );
}

try {
  testResetarsysBypassesHumanHandoff();
  testReiniciarAlsoBypassesHumanHandoff();
  console.log('[TESTE RESET/HANDOFF] comandos atravessam silêncio e buffer sem bloqueio: OK');
} finally {
  for (const file of TEST_FILES) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}
