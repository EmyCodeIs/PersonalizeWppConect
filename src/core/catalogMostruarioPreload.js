'use strict';

const WppClient = require('../services/wppconnectClient');
const { env } = require('../config/env');

const DEFAULT_CATALOG_NAME = 'Mostruário Letreiros';
const DEFAULT_FALLBACK_LINK = 'https://personalizeseuambiente.com.br/mostruario-letreiros';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function catalogSettleMs() {
  const configured = Number(process.env.LETTERING_CATALOG_SETTLE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1500;
}

function normalizeChatId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function getCatalogName() {
  return String(process.env.MOSTRUARIO_CATALOG_NAME || env.mostruarioCatalogName || DEFAULT_CATALOG_NAME).trim()
    || DEFAULT_CATALOG_NAME;
}

function getFallbackLink() {
  const value = String(env.mostruarioLinkUrl || process.env.MOSTRUARIO_LINK_URL || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : DEFAULT_FALLBACK_LINK;
}

function attachCatalogSender(channel) {
  if (!channel || channel.__catalogSenderInstalled) return channel;

  channel.sendCatalog = async function sendCatalog(clientId, payload = {}) {
    const chatId = normalizeChatId(clientId);
    const title = String(payload.title || getCatalogName()).trim() || getCatalogName();
    const description = String(payload.description || title).trim() || title;
    const textMessage = String(payload.textMessage || title).trim() || title;

    if (!chatId) return false;

    if (String(process.env.MOCK_MODE || '').trim().toLowerCase() === 'true') {
      console.log(`\n[CATÁLOGO -> ${chatId}] ${title}\n`);
      return true;
    }

    if (!channel?.client?.page?.evaluate) {
      console.warn('[CATÁLOGO] página do WhatsApp indisponível para envio nativo.');
      return false;
    }

    const pending = channel?.outboundTracker?.register?.(chatId, {
      type: 'text',
      text: textMessage,
    }) || null;

    try {
      const result = await channel.client.page.evaluate(async ({ chatId, title, description, textMessage }) => {
        const WPP = window.WPP || null;
        const ownWid = WPP?.conn?.getMyUserId?.();
        const catalogOwner = String(ownWid?._serialized || ownWid?.toString?.() || '').trim();

        if (!catalogOwner) throw new Error('CATALOG_OWNER_NOT_FOUND');
        if (typeof WPP?.chat?.sendCatalogMessage !== 'function') {
          throw new Error('CATALOG_SEND_UNAVAILABLE');
        }

        const sent = await WPP.chat.sendCatalogMessage(chatId, catalogOwner, {
          title,
          description,
          textMessage,
        });

        return {
          ok: Boolean(sent),
          id: String(sent?.id?._serialized || sent?.id || '').trim() || null,
        };
      }, { chatId, title, description, textMessage });

      channel?.outboundTracker?.confirm?.(pending, result);
      console.log(`[CATÁLOGO] enviado para ${chatId} | título=${title}`);
      return result?.ok !== false;
    } catch (error) {
      channel?.outboundTracker?.fail?.(pending);
      console.warn(`[CATÁLOGO] falha no envio nativo para ${chatId}:`, error?.message || error);
      return false;
    }
  };

  channel.__catalogSenderInstalled = true;
  return channel;
}

function wrapChannelFactory(name) {
  const original = WppClient[name];
  if (typeof original !== 'function' || original.__catalogMostruarioWrapped) return;

  const wrapped = async function createChannelWithCatalog(...args) {
    const channel = await original(...args);
    return attachCatalogSender(channel);
  };

  wrapped.__catalogMostruarioWrapped = true;
  WppClient[name] = wrapped;
}

async function sendMostruarioCatalog(channel, clientId) {
  const title = getCatalogName();
  let sent = false;

  if (typeof channel?.sendCatalog === 'function') {
    sent = await channel.sendCatalog(clientId, {
      title,
      description: title,
      textMessage: title,
    });
  }

  if (sent === false) {
    const fallbackLink = getFallbackLink();
    console.warn('[CATÁLOGO] envio nativo indisponível; usando link simples como contingência.');

    if (typeof channel?.sendText === 'function') {
      sent = await channel.sendText(clientId, fallbackLink, { noDelay: true, noTyping: true });
    } else {
      const chatId = normalizeChatId(clientId);
      if (chatId && typeof channel?.client?.sendText === 'function') {
        sent = await channel.client.sendText(chatId, fallbackLink);
      }
    }
  }

  if (sent === false || sent === null) return false;

  const settleMs = catalogSettleMs();
  if (settleMs) await wait(settleMs);
  console.log(`[CATÁLOGO] cartão estabilizado | cliente=${clientId} | espera=${settleMs}ms`);
  return true;
}

function installCatalogMostruario() {
  wrapChannelFactory('createWppChannel');
  wrapChannelFactory('createMockChannel');
}

installCatalogMostruario();

module.exports = {
  DEFAULT_CATALOG_NAME,
  DEFAULT_FALLBACK_LINK,
  attachCatalogSender,
  catalogSettleMs,
  getCatalogName,
  getFallbackLink,
  installCatalogMostruario,
  normalizeChatId,
  sendMostruarioCatalog,
};
