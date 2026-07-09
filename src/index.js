'use strict';

const { env } = require('./config/env');
const { BufferManager, mergeMessages } = require('./core/bufferManager');
const { processCustomerMessage } = require('./flow/customerFlow');
const { createWppChannel, createMockChannel } = require('./services/wppconnectClient');

async function main() {
  console.log('[PersonalizeWppConect] iniciando...');
  console.log(`[PersonalizeWppConect] modo: ${env.mockMode ? 'mock/local' : 'WPPConnect'}`);

  let channel = null;

  const buffer = new BufferManager({
    delayMs: env.bufferMs,
    onFlush: async (clientId, messages) => {
      const text = mergeMessages(messages);
      if (!text) return;
      console.log(`\n[CLIENTE ${clientId}] ${text}\n`);
      await processCustomerMessage({ clientId, text, channel });
    },
  });

  const onMessage = async ({ from, text }) => {
    buffer.push(from, { text });
  };

  if (env.mockMode) {
    channel = createMockChannel();
    console.log('[PersonalizeWppConect] MOCK_MODE ativo. Use npm run test:flow para simular conversa.');
    return;
  }

  channel = await createWppChannel({ onMessage });
  console.log('[PersonalizeWppConect] conectado. Aguardando mensagens...');
}

main().catch((err) => {
  console.error('[PersonalizeWppConect] erro fatal:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
