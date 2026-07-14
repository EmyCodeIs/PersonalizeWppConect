'use strict';

const WppClient = require('../services/wppconnectClient');
const SellerHandoff = require('./sellerHandoff');
const HumanControl = require('../services/humanControlStore');
const { env } = require('../config/env');

function normalizeChatId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function messageId(message = {}) {
  return String(
    message?.id?._serialized
    || message?.id
    || message?.messageId
    || message?.key?.id
    || ''
  ).trim();
}

function outgoingChatId(message = {}) {
  return normalizeChatId(
    message?.to
    || message?.chatId
    || message?.id?.remote
    || message?.key?.remoteJid
    || message?.from
    || ''
  );
}

function outgoingText(message = {}) {
  return String(
    message?.body
    || message?.caption
    || message?.text
    || message?.content
    || message?.description
    || ''
  ).trim();
}

function mediaMarker(message = {}) {
  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  const filename = message?.filename || message?.fileName || message?.document?.filename || '';
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || filename) {
    return `[arquivo enviado${filename ? `: ${filename}` : ''}]`;
  }
  if (/video/.test(type)) return '[vídeo enviado]';
  return '';
}

function createDeduplicatedOutgoingHandler(handler) {
  const seen = new Map();
  const ttlMs = 30000;

  return async function handleOutgoing(payload = {}) {
    if (typeof handler !== 'function') return;

    const raw = payload.raw || {};
    const chatId = normalizeChatId(payload.from || outgoingChatId(raw));
    if (!chatId || /@g\.us$/i.test(chatId)) return;

    const id = messageId(raw);
    const text = String(payload.text || outgoingText(raw) || mediaMarker(raw)).trim();
    const type = String(raw?.type || raw?.mimetype || raw?.mediaType || 'text').toLowerCase();
    const now = Date.now();

    for (const [key, createdAt] of seen.entries()) {
      if ((now - createdAt) > ttlMs) seen.delete(key);
    }

    const fallbackWindow = Math.floor(now / 5000);
    const key = id
      ? `id:${id}`
      : `fallback:${chatId}:${type}:${text.toLowerCase()}:${fallbackWindow}`;

    if (seen.has(key)) {
      console.log(`[HANDOFF] evento de saída duplicado ignorado: ${chatId} | chave=${key}`);
      return;
    }

    seen.set(key, now);
    await handler({ ...payload, from: chatId, text, raw });
  };
}

const originalGetAutomationBlock = SellerHandoff.getAutomationBlock;

SellerHandoff.getAutomationBlock = async function getAutomationBlockExactSeller(channel, clientId) {
  if (!env.sellerLabelBlockingEnabled) {
    return { blocked: false, reason: null };
  }

  const assignment = await SellerHandoff.detectSellerLabelAssignment(channel, clientId);
  if (assignment?.assigned && assignment.matchMode === 'name') {
    HumanControl.setBlock(clientId, {
      reason: 'seller_label',
      source: 'seller_label',
      seller: assignment.seller,
      labelName: assignment.labelName,
      blockedHours: env.humanBlockHours,
    });

    return {
      blocked: true,
      reason: 'seller_label',
      seller: assignment.seller,
      labelName: assignment.labelName,
      source: assignment.source,
      details: assignment,
    };
  }

  if (assignment?.assigned && assignment.matchMode !== 'name') {
    console.warn(
      `[HANDOFF] etiqueta ignorada por corresponder apenas à cor | chat=${clientId} `
      + `| etiqueta=${assignment.labelName || '-'} | vendedor=${assignment.seller || '-'}`,
    );
  }

  const humanControl = HumanControl.getBlock(clientId);
  if (humanControl?.blocked) {
    return {
      blocked: true,
      reason: humanControl.control?.reason || 'human_block',
      seller: humanControl.control?.seller || null,
      labelName: humanControl.control?.labelName || null,
      source: humanControl.control?.source || 'human_control',
      details: humanControl.control,
    };
  }

  return { blocked: false, reason: null };
};

const originalCreateWppChannel = WppClient.createWppChannel;

WppClient.createWppChannel = async function createWppChannelWithReliableOutgoing(options = {}) {
  const handleOutgoing = createDeduplicatedOutgoingHandler(options.onOutgoingMessage);
  const channel = await originalCreateWppChannel({
    ...options,
    onOutgoingMessage: handleOutgoing,
  });

  const client = channel?.client;
  if (typeof client?.onAnyMessage === 'function') {
    client.onAnyMessage(async (message) => {
      if (!message?.fromMe || message?.isGroupMsg) return;
      const from = outgoingChatId(message);
      if (!from) return;
      const text = outgoingText(message) || mediaMarker(message);
      await handleOutgoing({
        from,
        text,
        raw: message,
        channel,
        source: 'onAnyMessage',
      });
    });
    console.log('[HANDOFF] monitor de mensagens manuais ativo: onMessage + onAnyMessage com deduplicação');
  } else {
    console.warn('[HANDOFF] onAnyMessage indisponível; monitor manual usando somente onMessage');
  }

  return channel;
};

module.exports = {
  _test: {
    createDeduplicatedOutgoingHandler,
    mediaMarker,
    messageId,
    normalizeChatId,
    outgoingChatId,
    outgoingText,
    originalGetAutomationBlock,
  },
};
