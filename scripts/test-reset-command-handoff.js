'use strict';

const assert = require('assert/strict');

async function run() {
  process.env.ENABLE_TEST_COMMANDS = 'true';

  const envPath = require.resolve('../src/config/env');
  const clientPath = require.resolve('../src/services/wppconnectClient');
  const preloadPath = require.resolve('../src/core/resetCommandHandoffPreload');

  delete require.cache[envPath];
  delete require.cache[clientPath];
  delete require.cache[preloadPath];

  const WppClient = require('../src/services/wppconnectClient');
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async (options = {}) => ({
    emitOutgoing: (payload) => options.onOutgoingMessage?.(payload),
  });
  delete WppClient.__resetCommandHandoffBypassInstalled;

  require('../src/core/resetCommandHandoffPreload');

  const routedCommands = [];
  const manualMessages = [];
  const channel = await WppClient.createWppChannel({
    onMessage: async (payload) => routedCommands.push(payload),
    onOutgoingMessage: async (payload) => manualMessages.push(payload),
  });

  for (const command of ['/resetarsys', '/reset', '/reiniciar']) {
    await channel.emitOutgoing({
      from: '5511999999999@c.us',
      text: command,
      raw: { fromMe: true, type: 'chat', body: command },
      source: 'onAnyMessage',
    });
  }

  assert.equal(routedCommands.length, 3, 'comandos internos precisam voltar ao processador de entrada');
  assert.deepEqual(routedCommands.map((item) => item.text), ['/resetarsys', '/reset', '/reiniciar']);
  assert.ok(routedCommands.every((item) => item.source === 'manual-test-command'));
  assert.equal(manualMessages.length, 0, 'comandos internos não podem chegar ao handoff');

  await channel.emitOutgoing({
    from: '5511999999999@c.us',
    text: 'Vou assumir este atendimento.',
    raw: { fromMe: true, type: 'chat', body: 'Vou assumir este atendimento.' },
    source: 'onAnyMessage',
  });

  assert.equal(manualMessages.length, 1, 'mensagem humana comum precisa continuar chegando ao handoff');
  assert.equal(routedCommands.length, 3);

  WppClient.createWppChannel = originalCreateWppChannel;
  delete WppClient.__resetCommandHandoffBypassInstalled;

  console.log('✅ Reset/handoff verificado: comandos internos não bloqueiam o cliente; mensagem humana comum continua bloqueando.');
}

run().catch((error) => {
  console.error('❌ Teste reset/handoff falhou:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
