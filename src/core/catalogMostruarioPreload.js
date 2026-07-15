'use strict';

const WppClient = require('../services/wppconnectClient');
const Mostruario = require('./mostruario');
const { messages } = require('./messages');

const DEFAULT_CATALOG_NAME = 'Mostruário Letreiros';

function normalizeChatId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function getCatalogName() {
  return String(process.env.MOSTRUARIO_CATALOG_NAME || DEFAULT_CATALOG_NAME).trim()
    || DEFAULT_CATALOG_NAME;
}

function attachCatalogSender(channel) {
  if (!channel || channel.__catalogSenderInstalled) return channel;

  channel.sendCatalog = async function sendCatalog(clientId, payload = {}, options = {}) {
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
      // O catálogo é emitido pelo WhatsApp como uma mensagem de chat com link rico.
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

async function sendBudgetIntro(channel, clientId) {
  const text = String(messages.letteringBudgetIntro || '').trim();
  if (!text) {
    console.warn('[FLUXO][LETREIRO] explicação do orçamento ausente em messages.letteringBudgetIntro.');
    return false;
  }

  if (typeof channel?.sendText === 'function') {
    await channel.sendText(clientId, text, { noDelay: true, noTyping: true });
    return true;
  }

  const chatId = normalizeChatId(clientId);
  if (chatId && typeof channel?.client?.sendText === 'function') {
    await channel.client.sendText(chatId, text);
    return true;
  }

  console.warn(`[FLUXO][LETREIRO] não foi possível enviar a explicação do orçamento | cliente=${clientId}`);
  return false;
}

async function sendMostruarioCatalog(channel, clientId) {
  const title = getCatalogName();
  let catalogSent = false;

  if (typeof channel?.sendCatalog === 'function') {
    const sent = await channel.sendCatalog(clientId, {
      title,
      description: title,
      textMessage: title,
    }, {
      noDelay: true,
      noTyping: true,
    });

    catalogSent = sent !== false;
  }

  if (!catalogSent) {
    // Contingência sem a imagem antiga: envia somente o link já configurado.
    const fallbackLink = Mostruario.getMostruarioLink();
    console.warn('[CATÁLOGO] envio nativo indisponível; usando link simples como contingência.');

    if (typeof channel?.sendText === 'function') {
      await channel.sendText(clientId, fallbackLink, { noDelay: true, noTyping: true });
      catalogSent = true;
    } else {
      const chatId = normalizeChatId(clientId);
      if (chatId && typeof channel?.client?.sendText === 'function') {
        await channel.client.sendText(chatId, fallbackLink);
        catalogSent = true;
      }
    }
  }

  if (!catalogSent) return false;

  const introSent = await sendBudgetIntro(channel, clientId);
  if (introSent) {
    console.log(
      `[FLUXO][LETREIRO] catálogo e explicação enviados | cliente=${clientId} `
      + '| próximaEtapa=tipo_acrilico',
    );
  }

  return true;
}

function installCatalogMostruario() {
  wrapChannelFactory('createWppChannel');
  wrapChannelFactory('createMockChannel');
  Mostruario.sendMostruarioLetreiro = sendMostruarioCatalog;
}

installCatalogMostruario();

module.exports = {
  DEFAULT_CATALOG_NAME,
  attachCatalogSender,
  getCatalogName,
  installCatalogMostruario,
  normalizeChatId,
  sendBudgetIntro,
  sendMostruarioCatalog,
};
