'use strict';

const path = require('path');
const { env } = require('./config/env');
const { BufferManager, mergeMessages } = require('./core/bufferManager');
const { processCustomerMessage } = require('./flow/customerFlow');
const {
  createWppChannel,
  createMockChannel,
  collectUnreadMessages,
  normalizeChatId,
} = require('./services/wppconnectClient');
const { isAllowedClient } = require('./core/allowedClient');
const { extractName, normalizeText, titleCase } = require('./core/parsers');
const Store = require('./services/leadStore');
const Identity = require('./services/contactIdentity');

const BUILD_ID = 'typing-name-flow-review-2026-07-10-02';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function messageKey(message) {
  const rawId = message?.id?._serialized || message?.id || message?.messageId || message?.key?.id;
  if (rawId) return String(rawId);
  return `${message?.from || message?.chatId || 'unknown'}:${message?.text || message?.body || ''}:${message?.timestamp || ''}`;
}

function sanitizePersonName(value) {
  let name = String(value || '')
    .split(/[\n\r|•]/)[0]
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\+?\d[\d\s().-]{7,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name
    .replace(/^[^A-Za-zÀ-ÿ]+/u, '')
    .replace(/[^A-Za-zÀ-ÿ'’ -]+$/u, '')
    .trim();

  if (!name || name.length < 2 || name.length > 60 || !/[A-Za-zÀ-ÿ]/u.test(name)) return null;
  if (/\d{3,}/.test(name)) return null;

  const generic = normalizeText(name);
  if (['voce', 'você', 'usuario', 'usuário', 'whatsapp', 'desconhecido', 'unknown'].includes(generic)) {
    return null;
  }

  return titleCase(name);
}

function extractProfileName(raw) {
  const candidates = [
    raw?.notifyName,
    raw?.pushname,
    raw?.sender?.pushname,
    raw?.sender?.name,
    raw?.sender?.shortName,
    raw?.sender?.formattedName,
    raw?.contact?.pushname,
    raw?.contact?.name,
    raw?.contact?.shortName,
    raw?.contact?.formattedName,
    raw?.chat?.contact?.pushname,
    raw?.chat?.contact?.name,
    raw?.chat?.contact?.shortName,
    raw?.chat?.contact?.formattedName,
  ];

  for (const candidate of candidates) {
    const name = sanitizePersonName(candidate);
    if (name) return name;
  }
  return null;
}

function prepareBufferedInput(clientId, text, messages) {
  const session = Store.getSession(clientId);
  if (!session) return text;

  const explicitName = sanitizePersonName(extractName(text));
  const profileName = messages
    .map((item) => sanitizePersonName(item?.profileName) || extractProfileName(item?.raw))
    .find(Boolean);

  const chosenName = explicitName || (!session.dados?.nome ? profileName : null);
  if (chosenName) {
    session.dados = session.dados || {};
    session.dados.nome = chosenName;
    session.dados.nomeOrigem = explicitName ? 'mensagem' : 'perfil_whatsapp';
    Store.saveSession(session);
    console.log(`[CLIENTE ${clientId}] nome identificado (${session.dados.nomeOrigem}): ${chosenName}`);
  }

  if (session.etapa !== 'escolher_servico') return text;

  const normalized = normalizeText(text);
  if (/^(3|outro|outros|outro servico|outro serviço)$/.test(normalized)) return '3';
  if (/^(2|plotagem|plotar)$/.test(normalized)) return '2';
  if (/^(1|letreiro|letreiro de acrilico|letreiro de acrílico)$/.test(normalized)) return '1';
  return text;
}

function typingDuration(text, options = {}) {
  const fast = Boolean(options.fast);
  const min = fast ? Math.min(env.typingMinMs, 250) : env.typingMinMs;
  const max = fast ? Math.min(env.typingMaxMs, 700) : env.typingMaxMs;
  const estimated = Math.round((String(text || '').length / env.typingCharsPerSecond) * 1000);
  return Math.max(min, Math.min(max, estimated || min));
}

async function startTypingCompat(client, chatId) {
  const attempts = [
    async () => {
      if (typeof client?.startTyping !== 'function') return false;
      await client.startTyping(chatId);
      return true;
    },
    async () => {
      if (typeof client?.setChatState !== 'function') return false;
      await client.setChatState(chatId, 0);
      return true;
    },
  ];

  for (const attempt of attempts) {
    try {
      if (await attempt()) return true;
    } catch (_) {}
  }
  return false;
}

async function stopTypingCompat(client, chatId) {
  const attempts = [
    async () => {
      if (typeof client?.stopTyping !== 'function') return false;
      await client.stopTyping(chatId);
      return true;
    },
    async () => {
      if (typeof client?.setChatState !== 'function') return false;
      await client.setChatState(chatId, 2);
      return true;
    },
  ];

  for (const attempt of attempts) {
    try {
      if (await attempt()) return true;
    } catch (_) {}
  }
  return false;
}

async function runWithTyping(client, chatId, text, action, options = {}) {
  if (!env.enableTyping || options.noTyping) return action();

  const normalizedId = normalizeChatId(chatId);
  const started = await startTypingCompat(client, normalizedId);

  try {
    if (started) await wait(typingDuration(text, options));
    return await action();
  } finally {
    if (started) await stopTypingCompat(client, normalizedId);
  }
}

function installTyping(channel) {
  const client = channel?.client;
  if (!client || client.__personalizeTypingInstalled) return;

  const originalSendText = typeof client.sendText === 'function' ? client.sendText.bind(client) : null;
  const originalSendImage = typeof client.sendImage === 'function' ? client.sendImage.bind(client) : null;

  if (originalSendText) {
    client.sendText = async (chatId, text, ...rest) => {
      const content = String(text || '');
      const fast = content.includes(env.mostruarioLinkUrl) || /ver mostru[aá]rio/i.test(content);
      return runWithTyping(
        client,
        chatId,
        content,
        () => originalSendText(chatId, content, ...rest),
        { fast },
      );
    };

    channel.sendText = async (clientId, text, options = {}) => {
      const chatId = normalizeChatId(clientId);
      const content = String(text || '');
      return runWithTyping(
        client,
        chatId,
        content,
        () => originalSendText(chatId, content),
        options,
      );
    };
  }

  if (originalSendImage) {
    client.sendImage = async (chatId, filePath, fileName, caption = '', ...rest) => {
      const description = String(caption || fileName || 'enviando imagem');
      const fast = /capa[-_ ]?mostruario|mostruario[-_ ]?letreiro/i.test(`${filePath} ${fileName}`);
      return runWithTyping(
        client,
        chatId,
        description,
        () => originalSendImage(chatId, filePath, fileName, caption, ...rest),
        { fast },
      );
    };

    channel.sendImage = async (clientId, filePath, caption = '', options = {}) => {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      return runWithTyping(
        client,
        chatId,
        String(caption || 'enviando imagem'),
        () => originalSendImage(chatId, fullPath, path.basename(fullPath), String(caption || '')),
        options,
      );
    };
  }

  for (const methodName of ['sendListMessage', 'sendList', 'sendButtons']) {
    if (typeof client[methodName] !== 'function') continue;
    const original = client[methodName].bind(client);
    client[methodName] = async (chatId, ...args) => {
      const description = JSON.stringify(args[0] || args).slice(0, 300);
      return runWithTyping(client, chatId, description, () => original(chatId, ...args), { fast: true });
    };
  }

  channel.startTyping = async (clientId) => startTypingCompat(client, normalizeChatId(clientId));
  channel.stopTyping = async (clientId) => stopTypingCompat(client, normalizeChatId(clientId));
  client.__personalizeTypingInstalled = true;
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
  console.log(`[PersonalizeWppConect] digitando: ${env.enableTyping ? `${env.typingMinMs}-${env.typingMaxMs}ms` : 'desativado'}`);

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

      const preparedText = prepareBufferedInput(clientId, text, messages);
      console.log(`\n[CLIENTE ${clientId}] ${text}\n`);

      try {
        await processCustomerMessage({ clientId, text: preparedText, channel });
      } finally {
        await channel?.stopTyping?.(clientId).catch(() => null);
      }
    },
  });

  const onMessage = async ({ from, text, raw, source = 'event' }) => {
    const profileName = extractProfileName(raw);
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
    buffer.push(canonicalChatId, { text, raw, source, identity, profileName });
    await channel?.startTyping?.(canonicalChatId).catch(() => null);
  };

  if (env.mockMode) {
    channel = createMockChannel();
    blockPdfSending(channel);
    console.log('[PersonalizeWppConect] MOCK_MODE ativo. Use npm run test:flow para simular conversa.');
    return;
  }

  channel = await createWppChannel({ onMessage });
  blockPdfSending(channel);
  installTyping(channel);
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
