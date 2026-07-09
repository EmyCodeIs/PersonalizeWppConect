'use strict';

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
  const id = String(clientId || '').replace(/\D/g, '');
  if (!id) return '';
  return id.endsWith('@c.us') ? id : `${id}@c.us`;
}

function createMockChannel() {
  return {
    async sendText(clientId, text) {
      console.log(`\n[BOT -> ${clientId}] ${text}\n`);
    },
    async setContactNote(clientId, note) {
      console.log(`\n[NOTA ${clientId}]\n${note}\n`);
    },
    async applyContactLabel(clientId, label) {
      console.log(`\n[ETIQUETA ${clientId}] ${label?.name || label} (${label?.color || 'green'})\n`);
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

async function createWppChannel({ onMessage, onQr } = {}) {
  const wppconnect = require('@wppconnect-team/wppconnect');

  const client = await wppconnect.create({
    session: env.sessionName,
    catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log('\n[WPPConnect] Escaneie o QR Code abaixo com o WhatsApp Business:\n');
      console.log(asciiQR);
      if (typeof onQr === 'function') onQr({ base64Qr, asciiQR, attempts, urlCode });
    },
    statusFind: (statusSession, session) => {
      console.log('[WPPConnect]', session, statusSession);
    },
    headless: true,
    useChrome: true,
    autoClose: 0,
    folderNameToken: 'tokens',
  });

  const channel = {
    client,
    async sendText(clientId, text) {
      await wait(randomDelay());
      await client.sendText(normalizeChatId(clientId), String(text || ''));
    },
    async setContactNote(clientId, note) {
      // WPPConnect/WA-JS pode mudar esses métodos conforme versão.
      // Mantemos tentativa segura: se não existir, apenas ignora.
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

  client.onMessage(async (message) => {
    if (message?.fromMe) return;
    const from = String(message?.from || '').replace(/@c\.us$/i, '').replace(/\D/g, '');
    const text = message?.body || message?.caption || '';
    if (!from || !text) return;
    await onMessage?.({ from, text, raw: message, channel });
  });

  return channel;
}

module.exports = { createWppChannel, createMockChannel, normalizeChatId };
