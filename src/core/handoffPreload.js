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
  const candidates = [
    message?.id?._serialized,
    typeof message?.id === 'string' ? message.id : '',
    message?.messageId,
    message?.key?.id,
  ];
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim();
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

function firstVisibleString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return '';
}

function outgoingText(message = {}) {
  return firstVisibleString(
    message?.body,
    message?.caption,
    message?.text,
    message?.description,
  );
}

function outgoingType(message = {}) {
  return String(
    message?.type
    || message?.mimetype
    || message?.mediaType
    || ''
  ).trim().toLowerCase();
}

function mediaMarker(message = {}) {
  const type = outgoingType(message);
  const filename = message?.filename || message?.fileName || message?.document?.filename || '';
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || filename) {
    return `[arquivo enviado${filename ? `: ${filename}` : ''}]`;
  }
  if (/video/.test(type)) return '[vídeo enviado]';
  if (/audio|ptt/.test(type)) return '[áudio enviado]';
  if (/sticker/.test(type)) return '[figurinha enviada]';
  return '';
}

function isVisibleOutgoingEvent(message = {}, text = '') {
  const type = outgoingType(message);
  const visibleType = /^(?:chat|text|image|video|document|audio|ptt|sticker|list|buttons?|template|location|vcard)$/;
  if (!visibleType.test(type)) return false;
  if (/^(?:chat|text)$/.test(type)) return Boolean(String(text || '').trim());
  return true;
}

function createDeduplicatedOutgoingHandler(handler, isInternalLabelOperation = () => false) {
  const seen = new Map();
  const ttlMs = 30000;

  return async function handleOutgoing(payload = {}) {
    if (typeof handler !== 'function') return;

    const raw = payload.raw || {};
    const chatId = normalizeChatId(payload.from || outgoingChatId(raw));
    if (!chatId || /@g\.us$/i.test(chatId)) return;

    if (isInternalLabelOperation(chatId)) {
      console.log(`[HANDOFF] evento ignorado durante aplicação interna de etiqueta: ${chatId}`);
      return;
    }

    const id = messageId(raw);
    const text = firstVisibleString(payload.text, outgoingText(raw), mediaMarker(raw));
    const type = outgoingType(raw) || 'unknown';

    if (!isVisibleOutgoingEvent(raw, text)) {
      console.log(`[HANDOFF] evento não-mensagem ignorado: ${chatId} | tipo=${type}`);
      return;
    }

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
  const internalLabelOperations = new Map();
  const labelGuardMs = 8000;

  const purgeLabelOperations = () => {
    const now = Date.now();
    for (const [chatId, expiresAt] of internalLabelOperations.entries()) {
      if (expiresAt <= now) internalLabelOperations.delete(chatId);
    }
  };

  const isInternalLabelOperation = (chatId) => {
    purgeLabelOperations();
    return Number(internalLabelOperations.get(normalizeChatId(chatId)) || 0) > Date.now();
  };

  const markInternalLabelOperation = (chatId) => {
    const normalized = normalizeChatId(chatId);
    if (!normalized) return;
    internalLabelOperations.set(normalized, Date.now() + labelGuardMs);
  };

  const handleOutgoing = createDeduplicatedOutgoingHandler(
    options.onOutgoingMessage,
    isInternalLabelOperation,
  );

  const channel = await originalCreateWppChannel({
    ...options,
    onOutgoingMessage: handleOutgoing,
  });

  if (typeof channel?.applyContactLabel === 'function') {
    const originalApplyContactLabel = channel.applyContactLabel.bind(channel);
    channel.applyContactLabel = async (clientId, label = {}) => {
      markInternalLabelOperation(clientId);
      console.log(
        `[HANDOFF] proteção de operação interna ativada: ${normalizeChatId(clientId)} `
        + `| etiqueta=${String(label?.name || label || '-').trim() || '-'}`,
      );
      try {
        return await originalApplyContactLabel(clientId, label);
      } finally {
        markInternalLabelOperation(clientId);
      }
    };
  }

  channel.__markInternalLabelOperation = markInternalLabelOperation;
  channel.__isInternalLabelOperation = isInternalLabelOperation;

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
    firstVisibleString,
    isVisibleOutgoingEvent,
    mediaMarker,
    messageId,
    normalizeChatId,
    outgoingChatId,
    outgoingText,
    outgoingType,
    originalGetAutomationBlock,
  },
};
