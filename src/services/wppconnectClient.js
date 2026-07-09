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

  // IDs novos do WhatsApp podem chegar como @lid. Se trocar para @c.us,
  // o WA-JS pode falhar com "No LID for user". Por isso preservamos o sufixo real.
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
  if (!from || !text) return null;
  if (message?.fromMe) return null;
  if (message?.isGroupMsg || /@g\.us$/i.test(from)) return null;
  return { from, text, raw: message };
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
    },
    async applyContactLabel(clientId, label) {
      console.log(`\n[ETIQUETA ${clientId}] ${label?.name || label} (${label?.color || 'green'})\n`);
    },
    async markUnread(clientId) {
      console.log(`\n[MARCAR NÃO LIDO ${clientId}]\n`);
      return true;
    },
  };
}

async function tryClientLabelApi(client, chatId, labelName, color) {
  const methods = [
    async () => {
      if (typeof client.getAllLabels !== 'function') return false;
      const labels = await client.getAllLabels();
      const found = Array.isArray(labels)
        ? labels.find((item) => String(item?.name || item?.label || '').toLowerCase() === labelName.toLowerCase())
        : null;
      let label = found;
      if (!label && typeof client.createLabel === 'function') {
        label = await client.createLabel(labelName, color);
      }
      const labelId = label?.id || label?.labelId || label?.hexColor || label?.name || labelName;
      if (!labelId) return false;
      if (typeof client.addChatWLabels === 'function') {
        await client.addChatWLabels(chatId, [labelId]);
        return true;
      }
      if (typeof client.addOrRemoveLabels === 'function') {
        await client.addOrRemoveLabels([chatId], [labelId], []);
        return true;
      }
      if (typeof client.addLabelToChat === 'function') {
        await client.addLabelToChat(chatId, labelId);
        return true;
      }
      return false;
    },
    async () => {
      if (typeof client.addChatWLabels !== 'function') return false;
      await client.addChatWLabels(chatId, [labelName]);
      return true;
    },
  ];

  for (const run of methods) {
    try {
      const ok = await run();
      if (ok) return true;
    } catch (_) {}
  }
  return false;
}

async function tryPageLabelApi(client, chatId, labelName, color) {
  if (!client?.page?.evaluate) return false;
  try {
    return await client.page.evaluate(async ({ chatId, labelName, color }) => {
      const lower = String(labelName || '').toLowerCase();
      const WPP = window.WPP || null;
      if (!WPP) return false;

      async function getLabels() {
        if (WPP.labels?.getAllLabels) return WPP.labels.getAllLabels();
        if (WPP.label?.getAllLabels) return WPP.label.getAllLabels();
        if (WPP.chat?.getLabels) return WPP.chat.getLabels();
        return [];
      }

      async function createLabel() {
        if (WPP.labels?.create) return WPP.labels.create(labelName, { color });
        if (WPP.label?.create) return WPP.label.create(labelName, { color });
        if (WPP.labels?.addLabel) return WPP.labels.addLabel(labelName, color);
        return null;
      }

      const labels = await getLabels().catch(() => []);
      const list = Array.isArray(labels) ? labels : Object.values(labels || {});
      let label = list.find((item) => String(item?.name || item?.label || '').toLowerCase() === lower) || null;
      if (!label) label = await createLabel().catch(() => null);
      const labelId = label?.id || label?.labelId || label?.name || labelName;
      if (!labelId) return false;

      if (WPP.chat?.addLabels) {
        await WPP.chat.addLabels(chatId, [labelId]);
        return true;
      }
      if (WPP.chat?.addLabel) {
        await WPP.chat.addLabel(chatId, labelId);
        return true;
      }
      if (WPP.labels?.addChatLabels) {
        await WPP.labels.addChatLabels(chatId, [labelId]);
        return true;
      }
      if (WPP.label?.addChatLabels) {
        await WPP.label.addChatLabels(chatId, [labelId]);
        return true;
      }
      return false;
    }, { chatId, labelName, color });
  } catch (_) {
    return false;
  }
}

async function collectViaUnreadMethods(client) {
  const methodNames = ['getUnreadMessages', 'getAllUnreadMessages'];
  for (const name of methodNames) {
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

async function collectViaChats(client) {
  const getChats = typeof client.getAllChats === 'function'
    ? () => client.getAllChats()
    : typeof client.getAllChatsWithMessages === 'function'
      ? () => client.getAllChatsWithMessages()
      : null;

  if (!getChats) return [];

  const chats = await getChats().catch((err) => {
    console.warn('[WPPConnect] não foi possível listar chats:', err?.message || err);
    return [];
  });

  const chatList = (Array.isArray(chats) ? chats : Object.values(chats || {}))
    .filter((chat) => !chat?.isGroup && !chat?.isGroupMsg && !/@g\.us$/i.test(String(chat?.id?._serialized || chat?.id || '')))
    .filter((chat) => Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) > 0)
    .slice(0, env.unreadBootstrapMaxChats);

  const output = [];

  for (const chat of chatList) {
    const chatId = String(chat?.id?._serialized || chat?.id || chat?.contact?.id?._serialized || '').trim();
    const unreadCount = Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) || env.unreadBootstrapMaxMessagesPerChat;
    const limit = Math.min(env.unreadBootstrapMaxMessagesPerChat, unreadCount || env.unreadBootstrapMaxMessagesPerChat);

    let messages = Array.isArray(chat?.msgs) ? chat.msgs : Array.isArray(chat?.messages) ? chat.messages : [];

    if (!messages.length && chatId && typeof client.getAllMessagesInChat === 'function') {
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

      function readId(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        return value._serialized || value.id?._serialized || value.user || value.toString?.() || '';
      }

      function readText(message) {
        return String(message?.body || message?.caption || message?.text || '').trim();
      }

      const stores = window.Store || {};
      const chatCollection = WPP.chat?.getModelsArray?.() || stores.Chat?.models || stores.Chat?._models || [];
      const chats = Array.from(chatCollection || [])
        .filter((chat) => Number(chat?.unreadCount || chat?.unread || 0) > 0)
        .filter((chat) => !chat?.isGroup && !/@g\.us$/i.test(readId(chat?.id)))
        .slice(0, maxChats);

      const out = [];
      for (const chat of chats) {
        const chatId = readId(chat?.id);
        const unread = Number(chat?.unreadCount || chat?.unread || 0) || maxMessages;
        const limit = Math.min(maxMessages, unread || maxMessages);
        const msgs = Array.from(chat?.msgs?.models || chat?.msgs?._models || chat?.messages || [])
          .slice(-limit);

        for (const msg of msgs) {
          const from = readId(msg?.from) || chatId;
          const text = readText(msg);
          if (!from || !text || msg?.fromMe || /@g\.us$/i.test(from)) continue;
          out.push({ from, text, id: readId(msg?.id), timestamp: msg?.t || msg?.timestamp || null });
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

    if (normalized.length) console.log(`[WPPConnect] não lidas coletadas via page.evaluate: ${normalized.length}`);
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
    for (const item of found) all.push(item);
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
      console.log('[WPPConnect] Se a janela do Chrome abrir, leia o QR por ela. Também deixei o QR abaixo como fallback:\n');
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
      try {
        await client.sendText(chatId, String(text || ''));
      } catch (err) {
        console.error(`[WPPConnect] erro ao enviar mensagem para ${chatId}:`, err?.message || err);
        throw err;
      }
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
        if (client?.page?.evaluate) {
          await client.page.evaluate(async ({ chatId, note }) => {
            if (window.WPP?.chat?.setNotes) return window.WPP.chat.setNotes(chatId, note);
            if (window.WPP?.contact?.setNotes) return window.WPP.contact.setNotes(chatId, note);
            return null;
          }, { chatId, note });
        }
      } catch (err) {
        console.warn('[WPPConnect] nao foi possivel salvar nota:', err?.message || err);
      }
    },
    async markUnread(clientId) {
      const chatId = normalizeChatId(clientId);
      const attempts = [
        async () => {
          if (typeof client.markUnseenMessage !== 'function') return false;
          await client.markUnseenMessage(chatId);
          return true;
        },
        async () => {
          if (typeof client.markUnread !== 'function') return false;
          await client.markUnread(chatId);
          return true;
        },
        async () => {
          if (!client?.page?.evaluate) return false;
          return client.page.evaluate(async ({ chatId }) => {
            const WPP = window.WPP || null;
            if (WPP?.chat?.markIsUnread) {
              await WPP.chat.markIsUnread(chatId);
              return true;
            }
            if (WPP?.chat?.markUnread) {
              await WPP.chat.markUnread(chatId);
              return true;
            }
            const Store = window.Store || null;
            const chat = Store?.Chat?.get?.(chatId) || Store?.Chat?.find?.(chatId);
            if (chat?.markUnread) {
              await chat.markUnread();
              return true;
            }
            return false;
          }, { chatId });
        },
      ];

      for (const attempt of attempts) {
        try {
          const ok = await attempt();
          if (ok) {
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
      const labelName = String(label.name || env.awaitingQuoteLabelName || 'Aguardando orçamento').trim();
      const color = String(label.color || env.awaitingQuoteLabelColor || 'green').trim();
      if (!chatId || !labelName) return false;

      const ok = await tryClientLabelApi(client, chatId, labelName, color)
        || await tryPageLabelApi(client, chatId, labelName, color);

      if (!ok) {
        console.warn(`[WPPConnect] nao foi possivel aplicar etiqueta "${labelName}" em ${chatId}. Verifique suporte da versao/sessao Business.`);
      }
      return ok;
    },
  };

  client.onStateChange((state) => {
    console.log('[WPPConnect] estado:', state);
  });

  client.onMessage(async (message) => {
    if (message?.fromMe) return;
    if (message?.isGroupMsg) return;

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
