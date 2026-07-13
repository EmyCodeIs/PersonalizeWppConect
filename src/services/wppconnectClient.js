'use strict';

const path = require('path');
const { env } = require('../config/env');
const { applyNamedLabel } = require('../core/serviceLabels');
const {
  OutboundMessageTracker,
  outgoingChatId,
  messageId,
} = require('./outboundMessageTracker');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function randomDelay() {
  const min = env.minReplyDelayMs;
  const max = env.maxReplyDelayMs;
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function getInteractiveId(message = {}) {
  const candidates = [
    message?.selectedRowId,
    message?.selectedButtonId,
    message?.listResponse?.singleSelectReply?.selectedRowId,
    message?.listResponseMessage?.singleSelectReply?.selectedRowId,
    message?.buttonsResponseMessage?.selectedButtonId,
    message?.templateButtonReplyMessage?.selectedId,
    message?.interactive?.list_reply?.id,
    message?.interactive?.button_reply?.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) return value;
  }
  return '';
}

function isMediaMessage(message = {}) {
  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  return /image|video|audio|document|pdf|application|sticker/.test(type)
    || Boolean(message?.filename || message?.fileName || message?.document?.filename);
}

function safeCaption(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 2000) return '';
  if (/^data:[^;]+;base64,/i.test(text)) return '';
  if (text.length > 500 && /^[a-z0-9+/=\s]+$/i.test(text)) return '';
  return text;
}

function getMessageText(message) {
  const interactiveId = getInteractiveId(message);
  if (interactiveId) return interactiveId;

  // Em mensagens de mídia, `body` pode conter uma carga codificada enorme.
  // Apenas a legenda escrita pelo cliente deve entrar no fluxo.
  if (isMediaMessage(message)) return safeCaption(message?.caption);

  return String(message?.body || message?.text || message?.content || '').trim();
}

function getMediaMarker(message = {}) {
  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  const filename = message?.filename || message?.fileName || message?.document?.filename || '';
  if (/image|sticker/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || filename) return `[arquivo enviado${filename ? `: ${filename}` : ''}]`;
  if (/video/.test(type)) return '[vídeo enviado]';
  if (/audio|ptt/.test(type)) return '[áudio enviado]';
  return '';
}

function getMessageFrom(message, fallbackChatId = '') {
  return String(message?.from || message?.chatId || message?.sender?.id || fallbackChatId || '').trim();
}

function normalizeUnreadMessage(message, fallbackChatId = '') {
  const from = getMessageFrom(message, fallbackChatId);
  const text = getMessageText(message) || getMediaMarker(message);
  if (!from || !text || message?.fromMe) return null;
  if (message?.isGroupMsg || /@g\.us$/i.test(from)) return null;
  return { from, text, raw: message };
}

function looksEncoded(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^data:[^;]+;base64,/i.test(text)) return true;
  if (text.length > 1000) return true;
  return text.length > 500 && /^[a-z0-9+/=\s]+$/i.test(text);
}

function sanitizeBusinessNote(note) {
  const lines = String(note || '').split(/\r?\n/);
  const output = [];
  let needsArtMarker = false;

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      output.push('');
      continue;
    }

    if (/^Arquivos\/referências recebidos:/i.test(trimmed)) {
      needsArtMarker = true;
      continue;
    }

    if (/^(Descrição da arte|Pantone\/cor personalizada):/i.test(trimmed)) {
      const value = trimmed.replace(/^[^:]+:\s*/, '');
      if (looksEncoded(value)) {
        needsArtMarker = true;
        continue;
      }
    }

    if (looksEncoded(trimmed)) {
      needsArtMarker = true;
      continue;
    }

    output.push(trimmed);
  }

  if (needsArtMarker && !output.some((line) => line === 'Arquivo de arte na conversa')) {
    const cityIndex = output.findIndex((line) => /^Cidade:/i.test(line));
    if (cityIndex >= 0) output.splice(cityIndex, 0, 'Arquivo de arte na conversa');
    else output.push('Arquivo de arte na conversa');
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function createMockChannel() {
  const client = {
    async sendText(chatId, text) {
      console.log(`\n[BOT -> ${chatId}] ${text}\n`);
      return true;
    },
    async sendImage(chatId, filePath, fileName, caption = '') {
      console.log(`\n[IMAGEM -> ${chatId}] ${fileName || path.basename(filePath)}\n${caption}\n`);
      return true;
    },
    async sendListMessage(chatId, payload) {
      console.log(`\n[LISTA -> ${chatId}] ${payload?.description || ''}`);
      for (const section of payload?.sections || []) {
        console.log(`[${section.title}]`);
        for (const row of section.rows || []) console.log(`- ${row.id}: ${row.title}`);
      }
      return true;
    },
    async startTyping() { return true; },
    async stopTyping() { return true; },
  };

  return {
    client,
    async sendText(clientId, text) { return client.sendText(normalizeChatId(clientId), text); },
    async sendImage(clientId, filePath, caption = '') {
      const fullPath = path.resolve(process.cwd(), filePath);
      return client.sendImage(normalizeChatId(clientId), fullPath, path.basename(fullPath), caption);
    },
    async sendDocument(clientId, filePath, fileName, caption = '') {
      console.log(`\n[DOCUMENTO BLOQUEADO/TESTE -> ${clientId}] ${fileName || path.basename(filePath)}\n${caption}\n`);
      return true;
    },
    async setContactNote(clientId, note) {
      console.log(`\n[NOTA ${clientId}]\n${sanitizeBusinessNote(note)}\n`);
      return true;
    },
    async applyContactLabel(clientId, label) {
      console.log(`\n[ETIQUETA ${clientId}] ${label?.name || label} (${label?.color || 'green'})\n`);
      return true;
    },
    async markUnread(clientId) {
      console.log(`\n[MARCAR NÃO LIDO ${clientId}]\n`);
      return true;
    },
  };
}

async function collectViaUnreadMethods(client) {
  for (const name of ['getUnreadMessages', 'getAllUnreadMessages']) {
    if (typeof client?.[name] !== 'function') continue;
    try {
      const result = await client[name]();
      const list = Array.isArray(result) ? result : Object.values(result || {});
      const normalized = list.map((msg) => normalizeUnreadMessage(msg)).filter(Boolean);
      if (normalized.length) return normalized;
    } catch (err) {
      console.warn(`[WPPConnect] ${name} falhou:`, err?.message || err);
    }
  }
  return [];
}

async function listChatsCompat(client) {
  if (typeof client?.listChats === 'function') return client.listChats();
  if (typeof client?.getAllChats === 'function') return client.getAllChats();
  if (typeof client?.getAllChatsWithMessages === 'function') return client.getAllChatsWithMessages();
  return [];
}

async function collectViaChats(client) {
  let chats = [];
  try {
    const result = await listChatsCompat(client);
    chats = Array.isArray(result) ? result : Object.values(result || {});
  } catch (err) {
    console.warn('[WPPConnect] não foi possível listar chats:', err?.message || err);
    return [];
  }

  const chatList = chats
    .filter((chat) => !chat?.isGroup && !chat?.isGroupMsg && !/@g\.us$/i.test(String(chat?.id?._serialized || chat?.id || '')))
    .filter((chat) => Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) > 0)
    .slice(0, env.unreadBootstrapMaxChats);

  const output = [];
  for (const chat of chatList) {
    const chatId = String(chat?.id?._serialized || chat?.id || chat?.contact?.id?._serialized || '').trim();
    const unreadCount = Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) || env.unreadBootstrapMaxMessagesPerChat;
    const limit = Math.min(env.unreadBootstrapMaxMessagesPerChat, unreadCount);
    let messages = Array.isArray(chat?.msgs) ? chat.msgs : Array.isArray(chat?.messages) ? chat.messages : [];
    if (!messages.length && chatId && typeof client?.getAllMessagesInChat === 'function') {
      try { messages = await client.getAllMessagesInChat(chatId, true, false); } catch (_) {}
    }
    for (const message of (Array.isArray(messages) ? messages : Object.values(messages || {})).slice(-limit)) {
      const normalized = normalizeUnreadMessage(message, chatId);
      if (normalized) output.push(normalized);
    }
  }
  return output;
}

async function collectUnreadMessages(client) {
  const all = [];
  for (const collect of [collectViaUnreadMethods, collectViaChats]) {
    const found = await collect(client);
    all.push(...found);
    if (all.length) break;
  }
  const seen = new Set();
  return all.filter((item) => {
    const key = item?.raw?.id?._serialized || item?.raw?.id || `${item.from}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function botSendDescriptor(method, args = []) {
  const chatId = normalizeChatId(args[0]);
  if (method === 'sendText') return { chatId, kind: 'text', texts: [args[1]] };
  if (method === 'sendImage') return { chatId, kind: 'image', texts: [args[3]] };
  if (method === 'sendFile') return { chatId, kind: 'document', texts: [args[3], args[2]] };
  if (method === 'sendListMessage') {
    const payload = args[1] || {};
    return {
      chatId,
      kind: 'list',
      texts: [payload.description, payload.title, payload.buttonText],
    };
  }
  if (method === 'sendList') {
    return { chatId, kind: 'list', texts: [args[1], args[2], args[4]] };
  }
  return { chatId, kind: 'text', texts: [] };
}

function installProgrammaticSendTracking(client, {
  tracker,
  shouldSendBotMessage,
} = {}) {
  for (const method of ['sendText', 'sendImage', 'sendFile', 'sendListMessage', 'sendList']) {
    if (typeof client?.[method] !== 'function') continue;
    const marker = `__personalizeTracked_${method}`;
    if (client[marker]) continue;

    const original = client[method].bind(client);
    client[method] = async (...args) => {
      const descriptor = botSendDescriptor(method, args);
      if (
        descriptor.chatId
        && typeof shouldSendBotMessage === 'function'
        && shouldSendBotMessage(descriptor.chatId) === false
      ) {
        console.log(`[HANDOFF] envio do bot bloqueado em ${descriptor.chatId}; atendimento humano ativo.`);
        return false;
      }

      const token = tracker?.begin(descriptor);
      try {
        const result = await original(...args);
        tracker?.bindResult(token, result);
        return result;
      } catch (err) {
        tracker?.cancel(token);
        throw err;
      }
    };
    client[marker] = true;
  }
}

async function createWppChannel({
  onMessage,
  onManualOutgoing,
  onQr,
  shouldSendBotMessage,
} = {}) {
  const wppconnect = require('@wppconnect-team/wppconnect');
  console.log(`[WPPConnect] Chrome visível: ${env.wppHeadless ? 'não (headless)' : 'sim'}`);

  const client = await wppconnect.create({
    session: env.sessionName,
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log('\n[WPPConnect] Escaneie o QR Code com o WhatsApp Business.\n');
      console.log(asciiQR);
      if (typeof onQr === 'function') onQr({ base64Qr, asciiQR, attempts, urlCode });
    },
    statusFind: (statusSession, session) => console.log('[WPPConnect]', session, statusSession),
    headless: env.wppHeadless,
    useChrome: true,
    autoClose: false,
    folderNameToken: 'tokens',
  });

  const outboundTracker = new OutboundMessageTracker({ ttlMs: env.botOutboundTrackerTtlMs });
  installProgrammaticSendTracking(client, {
    tracker: outboundTracker,
    shouldSendBotMessage,
  });

  const channel = {
    client,
    outboundTracker,
    async sendText(clientId, text, options = {}) {
      const chatId = normalizeChatId(clientId);
      if (!options.noDelay) await wait(randomDelay());
      return client.sendText(chatId, String(text || ''));
    },
    async sendImage(clientId, filePath, caption = '', options = {}) {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!options.noDelay) await wait(randomDelay());
      if (typeof client.sendImage !== 'function') return false;
      await client.sendImage(chatId, fullPath, path.basename(fullPath), String(caption || ''));
      return true;
    },
    async sendDocument(clientId, filePath, fileName, caption = '', options = {}) {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!options.noDelay) await wait(randomDelay());
      if (typeof client.sendFile !== 'function') return false;
      await client.sendFile(chatId, fullPath, fileName || path.basename(fullPath), String(caption || ''));
      return true;
    },
    async setContactNote(clientId, note) {
      const chatId = normalizeChatId(clientId);
      const cleanNote = sanitizeBusinessNote(note);
      try {
        if (!client?.page?.evaluate) return false;
        return await client.page.evaluate(async ({ chatId, note: text }) => {
          if (window.WPP?.chat?.setNotes) return window.WPP.chat.setNotes(chatId, text);
          if (window.WPP?.contact?.setNotes) return window.WPP.contact.setNotes(chatId, text);
          return false;
        }, { chatId, note: cleanNote });
      } catch (err) {
        console.warn('[WPPConnect] não foi possível salvar nota:', err?.message || err);
        return false;
      }
    },
    async markUnread(clientId) {
      const chatId = normalizeChatId(clientId);
      const attempts = [
        async () => typeof client?.markUnseenMessage === 'function' && (await client.markUnseenMessage(chatId), true),
        async () => typeof client?.markUnread === 'function' && (await client.markUnread(chatId), true),
      ];
      for (const attempt of attempts) {
        try { if (await attempt()) return true; } catch (_) {}
      }
      return false;
    },
    async applyContactLabel(clientId, label = {}) {
      const target = {
        name: String(label.name || env.awaitingQuoteLabelName || 'Aguardando orçamento').trim(),
        color: String(label.color || env.awaitingQuoteLabelColor || 'gray').trim(),
      };
      const result = await applyNamedLabel({ client }, clientId, target);
      return result === true || result?.applied === true;
    },
  };

  client.onStateChange((state) => console.log('[WPPConnect] estado:', state));
  client.onMessage(async (message) => {
    if (message?.fromMe || message?.isGroupMsg) return;
    const from = String(message?.from || message?.chatId || '').trim();
    const text = getMessageText(message) || getMediaMarker(message);
    if (!from || !text) return;
    console.log(`[WPPConnect] mensagem recebida de ${from}`);
    await onMessage?.({ from, text, raw: message, channel });
  });

  if (env.detectManualSellerMessages && typeof client.onAnyMessage === 'function') {
    client.onAnyMessage(async (message) => {
      const fromMe = Boolean(message?.fromMe || message?.isSentByMe);
      if (!fromMe || message?.isGroupMsg || message?.isStatusV3) return;
      if (outboundTracker.consume(message)) return;

      const to = outgoingChatId(message);
      if (!to || /@g\.us$/i.test(to)) return;
      const text = getMessageText(message) || getMediaMarker(message) || '[mensagem enviada pelo vendedor]';
      console.log(`[HANDOFF] mensagem manual detectada para ${to}`);
      await onManualOutgoing?.({
        to,
        text,
        raw: message,
        messageId: messageId(message),
        channel,
      });
    });
  } else if (env.detectManualSellerMessages) {
    console.warn('[HANDOFF] client.onAnyMessage indisponível; mensagens manuais não serão detectadas.');
  }

  return channel;
}

module.exports = {
  createWppChannel,
  createMockChannel,
  normalizeChatId,
  collectUnreadMessages,
  getInteractiveId,
  getMessageText,
  getMediaMarker,
  isMediaMessage,
  sanitizeBusinessNote,
  installProgrammaticSendTracking,
};
