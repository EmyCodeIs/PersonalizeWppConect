'use strict';

const { env } = require('./config/env');
const { BufferManager, mergeMessages } = require('./core/bufferManager');
const { processCustomerMessage } = require('./flow/customerFlow');
const { createWppChannel, createMockChannel, collectUnreadMessages } = require('./services/wppconnectClient');
const { isAllowedClient } = require('./core/allowedClient');
const Identity = require('./services/contactIdentity');

const BUILD_ID = 'link-only-no-pdf-2026-07-10-01';

function messageKey(message) {
  const rawId = message?.id?._serialized || message?.id || message?.messageId || message?.key?.id;
  if (rawId) return String(rawId);
  return `${message?.from || message?.chatId || 'unknown'}:${message?.text || message?.body || ''}:${message?.timestamp || ''}`;
}

function blockPdfSending(channel) {
  if (!channel) return;

  if (typeof channel.sendDocument === 'function') {
    channel.sendDocument = async () => {
      console.warn('[BLOQUEIO PDF] tentativa de envio de documento bloqueada. O mostruário deve ser enviado apenas como link.');
      return false;
    };
  }

  const client = channel.client;
  if (typeof client?.sendFile !== 'function' || client.__personalizePdfGuardInstalled) return;

  const originalSendFile = client.sendFile.bind(client);
  client.sendFile = async (...args) => {
    const serializedArgs = args
      .map((value) => {
        if (typeof value === 'string') return value;
        try {
          return JSON.stringify(value);
        } catch (_) {
          return String(value || '');
        }
      })
      .join(' ')
      .toLowerCase();

    if (serializedArgs.includes('.pdf') || serializedArgs.includes('mostruario')) {
      console.warn('[BLOQUEIO PDF] client.sendFile bloqueado para PDF/mostruário.');
      return false;
    }

    return originalSendFile(...args);
  };
  client.__personalizePdfGuardInstalled = true;
}

async function main() {
  console.log('[PersonalizeWppConect] iniciando...');
  console.log(`[PersonalizeWppConect] BUILD: ${BUILD_ID}`);
  console.log('[PersonalizeWppConect] MODO MOSTRUÁRIO: SOMENTE LINK, PDF BLOQUEADO');
  console.log(`[PersonalizeWppConect] modo: ${env.mockMode ? 'mock/local' : 'WPPConnect'}`);
  console.log(`[PersonalizeWppConect] link do mostruário: ${env.mostruarioLinkUrl}`);

  if (env.allowedClientNumbers?.length || env.allowedChatIds?.length) {
    console.log(`[PersonalizeWppConect] whitelist ativa: números=${env.allowedClientNumbers.join(', ') || '-'} chatIds=${env.allowedChatIds.join(', ') || '-'}`);
  }

  let channel = null;
  const processedMessageIds = new Set();

  const buffer = new BufferManager({
    delayMs: env.bufferMs,
    onFlush: async (clientId, messages) => {
      const text = mergeMessages(messages);
      if (!text) return;
      console.log(`\n[CLIENTE ${clientId}] ${text}\n`);
      await processCustomerMessage({ clientId, text, channel });
    },
  });

  const onMessage = async ({ from, text, raw, source = 'event' }) => {
    const identity = Identity.registerContact({ chatId: from, raw });
    const canonicalChatId = identity?.primaryChatId || from;

    const allowed = isAllowedClient({ from: canonicalChatId, raw });
    if (!allowed.allowed) {
      console.log(`[PersonalizeWppConect] ignorado (${source}) fora da whitelist: ${canonicalChatId}`);
      if (allowed.candidates?.length) {
        console.log(`[PersonalizeWppConect] candidatos analisados: ${allowed.candidates.join(' | ')}`);
      }
      return;
    }

    const key = messageKey(raw || { from: canonicalChatId, text });
    if (processedMessageIds.has(key)) return;
    processedMessageIds.add(key);

    console.log(`[PersonalizeWppConect] mensagem enfileirada (${source}) de ${canonicalChatId}`);
    buffer.push(canonicalChatId, { text, raw, source, identity });
  };

  if (env.mockMode) {
    channel = createMockChannel();
    blockPdfSending(channel);
    console.log('[PersonalizeWppConect] MOCK_MODE ativo. Use npm run test:flow para simular conversa.');
    return;
  }

  channel = await createWppChannel({ onMessage });
  blockPdfSending(channel);
  console.log('[PersonalizeWppConect] conectado. Aguardando mensagens...');

  if (env.enableUnreadBootstrap) {
    console.log(`[PersonalizeWppConect] buscando mensagens não lidas em ${env.unreadBootstrapDelayMs}ms...`);
    setTimeout(async () => {
      try {
        const unread = await collectUnreadMessages(channel.client);
        console.log(`[PersonalizeWppConect] mensagens não lidas encontradas: ${unread.length}`);
        for (const item of unread) {
          await onMessage({
            from: item.from,
            text: item.text,
            raw: item.raw,
            source: 'unread-bootstrap',
          });
        }
      } catch (err) {
        console.warn('[PersonalizeWppConect] não foi possível buscar mensagens não lidas:', err?.message || err);
      }
    }, env.unreadBootstrapDelayMs).unref?.();
  }
}

main().catch((err) => {
  console.error('[PersonalizeWppConect] erro fatal:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
