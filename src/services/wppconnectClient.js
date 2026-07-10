'use strict';

const path = require('path');
const { env } = require('../config/env');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getMessageText(message) {
  return String(message?.body || message?.caption || message?.text || message?.content || '').trim();
}

function getMessageFrom(message, fallbackChatId = '') {
  return String(message?.from || message?.chatId || message?.sender?.id || fallbackChatId || '').trim();
}

function normalizeUnreadMessage(message, fallbackChatId = '') {
  const from = getMessageFrom(message, fallbackChatId);
  const text = getMessageText(message);
  if (!from || !text || message?.fromMe) return null;
  if (message?.isGroupMsg || /@g\.us$/i.test(from)) return null;
  return { from, text, raw: message };
}

function colorToHex(color) {
  const normalized = String(color || '').trim().toLowerCase();
  const map = {
    green: '#25D366',
    red: '#F15C6D',
    gray: '#A4A4A4',
    grey: '#A4A4A4',
    blue: '#53BDEB',
    yellow: '#F7D154',
    orange: '#F5A623',
    purple: '#A970FF',
    pink: '#FF8AC6',
  };
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized;
  return map[normalized] || '#A4A4A4';
}

function labelId(label) {
  return String(label?.id || label?.labelId || '').trim();
}

function labelName(label) {
  return String(label?.name || label?.label || '').trim();
}

function createMockChannel() {
  return {
    async sendText(clientId, text) {
      console.log(`\n[BOT -> ${clientId}] ${text}\n`);
    },
    async sendImage(clientId, filePath, caption = '') {
      console.log(`\n[IMAGEM -> ${clientId}] ${filePath}\n${caption}\n`);
      return true;
    },
    async sendDocument(clientId, filePath, fileName, caption = '') {
      console.log(`\n[DOCUMENTO -> ${clientId}] ${fileName || path.basename(filePath)}: ${filePath}\n${caption}\n`);
      return true;
    },
    async setContactNote(clientId, note) {
      console.log(`\n[NOTA ${clientId}]\n${note}\n`);
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

async function getAllLabels(client) {
  if (typeof client?.getAllLabels !== 'function') return [];
  try {
    const labels = await client.getAllLabels();
    return Array.isArray(labels) ? labels : Object.values(labels || {});
  } catch (err) {
    console.warn('[WPPConnect] não foi possível listar etiquetas:', err?.message || err);
    return [];
  }
}

async function findOrCreateLabel(client, name, color) {
  let labels = await getAllLabels(client);
  let found = labels.find((item) => labelName(item).toLowerCase() === name.toLowerCase());
  if (found) return found;

  if (typeof client?.addNewLabel !== 'function') return null;

  try {
    const created = await client.addNewLabel(name, {
      labelColor: colorToHex(color),
    });

    if (created && typeof created === 'object') return created;

    labels = await getAllLabels(client);
    found = labels.find((item) => labelName(item).toLowerCase() === name.toLowerCase());
    return found || null;
  } catch (err) {
    console.warn(`[WPPConnect] não foi possível criar etiqueta "${name}":`, err?.message || err);
    return null;
  }
}

async function applyLabelCurrentApi(client, chatId, labelNameValue, color) {
  if (typeof client?.addOrRemoveLabels !== 'function') return false;

  const label = await findOrCreateLabel(client, labelNameValue, color);
  const id = labelId(label);
  if (!id) return false;

  await client.addOrRemoveLabels([chatId], [
    { labelId: id, type: 'add' },
  ]);
  return true;
}

async function applyLabelFallback(client, chatId, labelNameValue) {
  const attempts = [
    async () => {
      if (typeof client?.addChatWLabels !== 'function') return false;
      await client.addChatWLabels(chatId, [labelNameValue]);
      return true;
    },
    async () => {
      if (!client?.page?.evaluate) return false;
      return client.page.evaluate(async ({ chatId, labelNameValue }) => {
        const WPP = window.WPP || null;
        if (!WPP?.labels) return false;
        const labels = await WPP.labels.getAllLabels();
        const list = Array.isArray(labels) ? labels : Object.values(labels || {});
        const found = list.find((item) => String(item?.name || '').toLowerCase() === labelNameValue.toLowerCase());
        if (!found?.id) return false;
        await WPP.labels.addOrRemoveLabels([chatId], [
          { labelId: String(found.id), type: 'add' },
        ]);
        return true;
      }, { chatId, labelNameValue });
    },
  ];

  for (const attempt of attempts) {
    try {
      if (await attempt()) return true;
    } catch (_) {}
  }
  return false;
}

async function collectViaUnreadMethods(client) {
  for (const name of ['getUnreadMessages', 'getAllUnreadMessages']) {
    if (typeof client?.[name] !== 'function') continue;
    try {
      const result = await client[name]();
      const list = Array.isArray(result) ? result : Object.values(result || {});
      const normalized = list.map((msg) => normalizeUnreadMessage(msg)).filter(Boolean);
      if (normalized.length) {
        console.log(`[WPPConnect] não lidas coletadas via ${name}: ${normalized.length}`);
        return normalized;
      }
    } catch (err) {
      console.warn(`[WPPConnect] ${name} falhou:`, err?.message || err);
    }
  }
  return [];
}

async function listChatsCompat(client) {
  if (typeof client?.listChats === 'function') {
    return client.listChats();
  }
  if (typeof client?.getAllChats === 'function') {
    console.warn('[WPPConnect] listChats indisponível; usando getAllChats como fallback legado.');
    return client.getAllChats();
  }
  if (typeof client?.getAllChatsWithMessages === 'function') {
    return client.getAllChatsWithMessages();
  }
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
    const unreadCount = Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0)
      || env.unreadBootstrapMaxMessagesPerChat;
    const limit = Math.min(env.unreadBootstrapMaxMessagesPerChat, unreadCount);

    let messages = Array.isArray(chat?.msgs)
      ? chat.msgs
      : Array.isArray(chat?.messages)
        ? chat.messages
        : [];

    if (!messages.length && chatId && typeof client?.getAllMessagesInChat === 'function') {
      try {
        messages = await client.getAllMessagesInChat(chatId, true, false);
      } catch (err) {
        console.warn(`[WPPConnect] getAllMessagesInChat falhou para ${chatId}:`, err?.message || err);
      }
    }

    const recent = (Array.isArray(messages) ? messages : Object.values(messages || {})).slice(-limit);
    for (const message of recent) {
      const normalized = normalizeUnreadMessage(message, chatId);
      if (normalized) output.push(normalized);
    }
  }

  if (output.length) console.log(`[WPPConnect] não lidas coletadas via chats: ${output.length}`);
  return output;
}

async function collectViaPage(client) {
  if (!client?.page?.evaluate) return [];

  try {
    const result = await client.page.evaluate(({ maxChats, maxMessages }) => {
      const WPP = window.WPP || null;
      if (!WPP) return [];

      const readId = (value) => {
        if (!value) return '';
        if (typeof value === 'string') return value;
        return value._serialized || value.id?._serialized || value.user || value.toString?.() || '';
      };

      const readText = (message) => String(message?.body || message?.caption || message?.text || '').trim();
      const stores = window.Store || {};
      const collection = WPP.chat?.getModelsArray?.() || stores.Chat?.models || stores.Chat?._models || [];
      const chats = Array.from(collection || [])
        .filter((chat) => Number(chat?.unreadCount || chat?.unread || 0) > 0)
        .filter((chat) => !chat?.isGroup && !/@g\.us$/i.test(readId(chat?.id)))
        .slice(0, maxChats);

      const out = [];
      for (const chat of chats) {
        const chatId = readId(chat?.id);
        const unread = Number(chat?.unreadCount || chat?.unread || 0) || maxMessages;
        const messages = Array.from(chat?.msgs?.models || chat?.msgs?._models || chat?.messages || [])
          .slice(-Math.min(maxMessages, unread));

        for (const message of messages) {
          const from = readId(message?.from) || chatId;
          const text = readText(message);
          if (!from || !text || message?.fromMe || /@g\.us$/i.test(from)) continue;
          out.push({
            from,
            text,
            id: readId(message?.id),
            timestamp: message?.t || message?.timestamp || null,
          });
        }
      }
      return out;
    }, {
      maxChats: env.unreadBootstrapMaxChats,
      maxMessages: env.unreadBootstrapMaxMessagesPerChat,
    });

    const normalized = (Array.isArray(result) ? result : [])
      .map((msg) => normalizeUnreadMessage({ ...msg, id: msg.id, timestamp: msg.timestamp }, msg.from))
      .filter(Boolean);

    if (normalized.length) {
      console.log(`[WPPConnect] não lidas coletadas via page.evaluate: ${normalized.length}`);
    }
    return normalized;
  } catch (err) {
    console.warn('[WPPConnect] busca de não lidas via page.evaluate falhou:', err?.message || err);
    return [];
  }
}

async function collectUnreadMessages(client) {
  const all = [];
  for (const collect of [collectViaUnreadMethods, collectViaChats, collectViaPage]) {
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

async function createWppChannel({ onMessage, onQr } = {}) {
  const wppconnect = require('@wppconnect-team/wppconnect');

  console.log(`[WPPConnect] Chrome visível: ${env.wppHeadless ? 'não (headless)' : 'sim'}`);

  const client = await wppconnect.create({
    session: env.sessionName,
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log('\n[WPPConnect] Escaneie o QR Code com o WhatsApp Business.');
      console.log('[WPPConnect] Se a janela do Chrome abrir, leia o QR por ela. O QR abaixo é fallback:\n');
      console.log(asciiQR);
      if (typeof onQr === 'function') onQr({ base64Qr, asciiQR, attempts, urlCode });
    },
    statusFind: (statusSession, session) => {
      console.log('[WPPConnect]', session, statusSession);
    },
    headless: env.wppHeadless,
    useChrome: true,
    autoClose: false,
    folderNameToken: 'tokens',
  });

  const channel = {
    client,
    async sendText(clientId, text) {
      const chatId = normalizeChatId(clientId);
      await wait(randomDelay());
      await client.sendText(chatId, String(text || ''));
    },
    async sendImage(clientId, filePath, caption = '') {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      await wait(randomDelay());
      if (typeof client.sendImage !== 'function') return false;
      await client.sendImage(chatId, fullPath, path.basename(fullPath), String(caption || ''));
      return true;
    },
    async sendDocument(clientId, filePath, fileName, caption = '') {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      await wait(randomDelay());
      if (typeof client.sendFile !== 'function') return false;
      await client.sendFile(chatId, fullPath, fileName || path.basename(fullPath), String(caption || ''));
      return true;
    },
    async setContactNote(clientId, note) {
      const chatId = normalizeChatId(clientId);
      try {
        if (!client?.page?.evaluate) return false;
        return await client.page.evaluate(async ({ chatId, note }) => {
          if (window.WPP?.chat?.setNotes) return window.WPP.chat.setNotes(chatId, note);
          if (window.WPP?.contact?.setNotes) return window.WPP.contact.setNotes(chatId, note);
          return false;
        }, { chatId, note });
      } catch (err) {
        console.warn('[WPPConnect] não foi possível salvar nota:', err?.message || err);
        return false;
      }
    },
    async markUnread(clientId) {
      const chatId = normalizeChatId(clientId);
      const attempts = [
        async () => {
          if (typeof client?.markUnseenMessage !== 'function') return false;
          await client.markUnseenMessage(chatId);
          return true;
        },
        async () => {
          if (typeof client?.markUnread !== 'function') return false;
          await client.markUnread(chatId);
          return true;
        },
        async () => {
          if (!client?.page?.evaluate) return false;
          return client.page.evaluate(async ({ chatId }) => {
            if (window.WPP?.chat?.markIsUnread) {
              await window.WPP.chat.markIsUnread(chatId);
              return true;
            }
            if (window.WPP?.chat?.markUnread) {
              await window.WPP.chat.markUnread(chatId);
              return true;
            }
            return false;
          }, { chatId });
        },
      ];

      for (const attempt of attempts) {
        try {
          if (await attempt()) {
            console.log(`[WPPConnect] marcado como não lido: ${chatId}`);
            return true;
          }
        } catch (_) {}
      }
      console.warn(`[WPPConnect] não consegui marcar como não lido: ${chatId}`);
      return false;
    },
    async applyContactLabel(clientId, label = {}) {
      if (!env.enableContactLabels) return false;
      const chatId = normalizeChatId(clientId);
      const name = String(label.name || env.awaitingQuoteLabelName || 'Aguardando orçamento').trim();
      const color = String(label.color || env.awaitingQuoteLabelColor || 'green').trim();
      if (!chatId || !name) return false;

      let ok = false;
      try {
        ok = await applyLabelCurrentApi(client, chatId, name, color);
      } catch (err) {
        console.warn(`[WPPConnect] API atual de etiquetas falhou para "${name}":`, err?.message || err);
      }

      if (!ok) ok = await applyLabelFallback(client, chatId, name);
      if (!ok) {
        console.warn(`[WPPConnect] não foi possível aplicar etiqueta "${name}" em ${chatId}.`);
      }
      return ok;
    },
  };

  client.onStateChange((state) => {
    console.log('[WPPConnect] estado:', state);
  });

  client.onMessage(async (message) => {
    if (message?.fromMe || message?.isGroupMsg) return;
    const from = String(message?.from || message?.chatId || '').trim();
    const text = getMessageText(message);
    if (!from || !text) return;
    console.log(`[WPPConnect] mensagem recebida de ${from}`);
    await onMessage?.({ from, text, raw: message, channel });
  });

  return channel;
}

module.exports = {
  createWppChannel,
  createMockChannel,
  normalizeChatId,
  collectUnreadMessages,
};
