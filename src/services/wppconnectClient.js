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
  };
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
