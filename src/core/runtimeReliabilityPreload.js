'use strict';

const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');
const HumanControl = require('../services/humanControlStore');
const BotActivity = require('../services/botActivityStore');
const WppClient = require('../services/wppconnectClient');
const { OutboundTracker } = require('./outboundTracker');
const SellerHandoff = require('./sellerHandoff');
const { env } = require('../config/env');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeIntentText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isShortAcknowledgement(value) {
  const normalized = normalizeIntentText(value);
  if (!normalized) return false;

  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length || tokens.length > 4) return false;

  const core = new Set([
    'obg', 'obgd', 'obrigado', 'obrigada', 'obrigadao',
    'valeu', 'vlw', 'agradeco', 'gratidao', 'tmj',
    'ok', 'okay', 'certo', 'beleza', 'blz', 'show', 'perfeito',
  ]);
  const modifiers = new Set(['muito', 'mesmo', 'viu', 'ta', 'bom', 'entendi', 'entendido']);

  const hasCore = tokens.some((token) => core.has(token));
  return hasCore && tokens.every((token) => core.has(token) || modifiers.has(token));
}

function extractMessageId(message = {}) {
  return String(
    message?.id?._serialized
    || message?.id
    || message?.messageId
    || message?.key?.id
    || ''
  ).trim() || null;
}

function extractChatId(message = {}, fallback = '') {
  return Identity.normalizeChatId(
    message?.from
    || message?.chatId
    || message?.id?.remote
    || message?.key?.remoteJid
    || fallback
    || ''
  );
}

function extractTimestampMs(message = {}) {
  const candidates = [
    message?.timestamp,
    message?.t,
    message?.messageTimestamp,
    message?.id?.timestamp,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value < 1000000000000 ? value * 1000 : value;
  }
  return null;
}

function visibleMessageText(message = {}) {
  return String(message?.body || message?.caption || message?.text || '').trim();
}

function mediaMarker(message = {}) {
  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  const filename = message?.filename || message?.fileName || message?.document?.filename || '';
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || filename) return `[arquivo enviado${filename ? `: ${filename}` : ''}]`;
  if (/video/.test(type)) return '[vídeo enviado]';
  if (/audio|ptt/.test(type)) return '[áudio enviado]';
  return '';
}

function isVisibleOutgoing(message = {}) {
  if (!message?.fromMe) return false;
  return Boolean(visibleMessageText(message) || mediaMarker(message));
}

function normalizeUnreadMessage(message = {}, fallbackChatId = '') {
  const from = extractChatId(message, fallbackChatId);
  const text = visibleMessageText(message) || mediaMarker(message);
  if (!from || !text || message?.fromMe) return null;
  if (message?.isGroupMsg || /@g\.us$/i.test(from)) return null;
  return { from, text, raw: message };
}

function unreadKey(item = {}) {
  return extractMessageId(item.raw)
    || `${Identity.normalizeChatId(item.from)}:${item.text}:${extractTimestampMs(item.raw) || ''}`;
}

async function listChatsCompat(client) {
  if (typeof client?.listChats === 'function') return client.listChats();
  if (typeof client?.getAllChats === 'function') return client.getAllChats();
  if (typeof client?.getAllChatsWithMessages === 'function') return client.getAllChatsWithMessages();
  return [];
}

async function collectUnreadFromChats(client) {
  let chats = [];
  try {
    const result = await listChatsCompat(client);
    chats = Array.isArray(result) ? result : Object.values(result || {});
  } catch (_) {
    return [];
  }

  const selected = chats
    .filter((chat) => !chat?.isGroup && !chat?.isGroupMsg)
    .filter((chat) => Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0) > 0)
    .slice(0, env.unreadBootstrapMaxChats || 30);

  const output = [];
  for (const chat of selected) {
    const chatId = String(chat?.id?._serialized || chat?.id || chat?.contact?.id?._serialized || '').trim();
    if (!chatId || /@g\.us$/i.test(chatId)) continue;

    const unreadCount = Number(chat?.unreadCount || chat?.unread || chat?.unreadMessages || 0)
      || env.unreadBootstrapMaxMessagesPerChat
      || 8;
    const limit = Math.min(env.unreadBootstrapMaxMessagesPerChat || 8, unreadCount);
    let messages = Array.isArray(chat?.msgs) ? chat.msgs : (Array.isArray(chat?.messages) ? chat.messages : []);

    if (!messages.length && typeof client?.getAllMessagesInChat === 'function') {
      try { messages = await client.getAllMessagesInChat(chatId, true, false); } catch (_) {}
    }

    const list = Array.isArray(messages) ? messages : Object.values(messages || {});
    for (const message of list.slice(-limit)) {
      const normalized = normalizeUnreadMessage(message, chatId);
      if (normalized) output.push(normalized);
    }
  }

  return output;
}

function candidateChatIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  let known = [];
  try { known = Identity.getLabelCandidateIds(clientId); } catch (_) {}
  return [...new Set([direct, ...known].filter(Boolean))];
}

async function readConversationHistory(client, clientId) {
  const candidates = candidateChatIds(clientId);
  const attempts = [];

  for (const chatId of candidates) {
    if (typeof client?.getAllMessagesInChat === 'function') {
      try {
        const raw = await client.getAllMessagesInChat(chatId, true, false);
        const messages = Array.isArray(raw) ? raw : Object.values(raw || {});
        attempts.push({ chatId, available: true, messages });
        if (messages.length) return { available: true, chatId, messages };
      } catch (_) {}
    }
  }

  if (client?.page?.evaluate) {
    for (const chatId of candidates) {
      try {
        const messages = await client.page.evaluate(async ({ chatId, limit }) => {
          const WPP = window.WPP || null;
          if (typeof WPP?.chat?.getMessages !== 'function') return null;
          const raw = await WPP.chat.getMessages(chatId, { count: limit, direction: 'before' });
          return Array.isArray(raw) ? raw : Object.values(raw || {});
        }, { chatId, limit: env.unreadRecoveryHistoryLimit || 120 });
        if (Array.isArray(messages)) {
          attempts.push({ chatId, available: true, messages });
          if (messages.length) return { available: true, chatId, messages };
        }
      } catch (_) {}
    }
  }

  const available = attempts.some((item) => item.available);
  return { available, chatId: candidates[0] || null, messages: [] };
}

async function inspectUnreadRecovery(client, clientId) {
  const currentBlock = await SellerHandoff.getAutomationBlock({ client }, clientId);
  if (currentBlock?.blocked) {
    return { eligible: false, reason: currentBlock.reason || 'human_block' };
  }

  const history = await readConversationHistory(client, clientId);
  if (!history.available) {
    return { eligible: false, reason: 'historico_indisponivel' };
  }

  const messages = [...(history.messages || [])].sort((a, b) => {
    const at = extractTimestampMs(a);
    const bt = extractTimestampMs(b);
    if (at === null || bt === null) return 0;
    return at - bt;
  });
  const outgoing = messages.filter(isVisibleOutgoing);
  const checkpoint = BotActivity.getLastBotOutbound(clientId);

  if (!checkpoint) {
    if (outgoing.length) {
      return { eligible: false, reason: 'sem_checkpoint_com_saida_anterior' };
    }
    return { eligible: true, reason: 'conversa_nova_sem_saida' };
  }

  let manualAfterCheckpoint = [];
  const checkpointId = String(checkpoint.messageId || '').trim();
  const checkpointIndex = checkpointId
    ? messages.findIndex((message) => extractMessageId(message) === checkpointId)
    : -1;

  if (checkpointIndex >= 0) {
    manualAfterCheckpoint = messages.slice(checkpointIndex + 1).filter(isVisibleOutgoing);
  } else {
    const checkpointAt = new Date(checkpoint.at).getTime();
    if (!Number.isFinite(checkpointAt)) {
      return { eligible: false, reason: 'checkpoint_invalido' };
    }
    manualAfterCheckpoint = outgoing.filter((message) => {
      const timestamp = extractTimestampMs(message);
      return timestamp !== null && timestamp > (checkpointAt + 1500);
    });
  }

  if (manualAfterCheckpoint.length) {
    HumanControl.setBlock(clientId, {
      reason: 'manual_outbound_history',
      source: 'unread_recovery_history',
      persistent: true,
    });
    return {
      eligible: false,
      reason: 'vendedor_encontrado_no_historico',
      messageId: extractMessageId(manualAfterCheckpoint[0]),
    };
  }

  return { eligible: true, reason: 'sem_atendimento_humano_apos_bot' };
}

function installPersistentHumanHistory() {
  if (HumanControl.__persistentHumanHistoryInstalled) return;

  const originalSetBlock = HumanControl.setBlock.bind(HumanControl);
  HumanControl.setBlock = function setPersistentHumanBlock(clientId, payload = {}) {
    const reason = String(payload?.reason || '').trim();
    const permanentReason = [
      'manual_outbound_message',
      'manual_outbound_history',
      'seller_label',
    ].includes(reason);
    return originalSetBlock(clientId, {
      ...payload,
      persistent: permanentReason ? true : payload.persistent,
    });
  };

  const originalGetBlock = HumanControl.getBlock.bind(HumanControl);
  HumanControl.getBlock = function getPersistentHumanBlock(clientId) {
    const result = originalGetBlock(clientId);
    const control = result?.control;
    if (result?.blocked
      && ['manual_outbound_message', 'manual_outbound_history', 'seller_label'].includes(String(control?.reason || ''))
      && control?.blockedUntil) {
      const migrated = originalSetBlock(clientId, { ...control, persistent: true });
      return { blocked: true, control: migrated };
    }
    return result;
  };

  HumanControl.__persistentHumanHistoryInstalled = true;
}

function installBotActivityTracking() {
  if (OutboundTracker.prototype.__botActivityTrackingInstalled) return;
  const originalConfirm = OutboundTracker.prototype.confirm;
  OutboundTracker.prototype.confirm = function confirmAndPersistBotActivity(item, result) {
    const confirmed = originalConfirm.call(this, item, result);
    if (confirmed?.chatId) {
      try {
        BotActivity.markBotOutbound(confirmed.chatId, {
          at: new Date(confirmed.createdAt || Date.now()).toISOString(),
          messageId: confirmed.messageId || extractMessageId(result),
          type: confirmed.type,
        });
      } catch (_) {}
    }
    return confirmed;
  };
  OutboundTracker.prototype.__botActivityTrackingInstalled = true;
}

function installGratitudeReply() {
  const CustomerFlow = require('../flow/customerFlow');
  if (CustomerFlow.__gratitudeReplyInstalled) return;

  const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;
  CustomerFlow.processCustomerMessage = async function processCustomerMessageWithAcknowledgement(args = {}) {
    if (isShortAcknowledgement(args.text)) {
      const session = Store.getSession(args.clientId);
      await args.channel?.sendText?.(args.clientId, '👍');
      console.log(`[FLUXO] agradecimento/confirmação curta reconhecida sem alterar etapa | cliente=${args.clientId}`);
      return session;
    }
    return originalProcessCustomerMessage(args);
  };

  CustomerFlow.__gratitudeReplyInstalled = true;
}

function installUnreadRecoveryGuard() {
  if (WppClient.__safeUnreadRecoveryInstalled) return;
  const originalCollectUnreadMessages = WppClient.collectUnreadMessages.bind(WppClient);

  WppClient.collectUnreadMessages = async function collectUnreadMessagesSafely(client) {
    const attempts = Math.max(1, Number(env.unreadBootstrapAttempts || 3));
    const retryDelayMs = Math.max(500, Number(env.unreadBootstrapRetryDelayMs || 2500));
    const collected = [];

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { collected.push(...await originalCollectUnreadMessages(client)); } catch (_) {}
      try { collected.push(...await collectUnreadFromChats(client)); } catch (_) {}
      if (attempt < attempts) await wait(retryDelayMs);
    }

    const unique = [];
    const seen = new Set();
    for (const item of collected) {
      const key = unreadKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    const eligibility = new Map();
    const accepted = [];
    for (const item of unique) {
      const identity = Identity.registerContact({ chatId: item.from, raw: item.raw });
      const clientId = identity?.primaryChatId || item.from;
      const key = String(Identity.getSessionKey(clientId) || clientId);

      if (!eligibility.has(key)) {
        const result = await inspectUnreadRecovery(client, clientId);
        eligibility.set(key, result);
        console.log(
          `[RECUPERAÇÃO] conversa não lida ${result.eligible ? 'liberada' : 'ignorada'} `
          + `| cliente=${clientId} | motivo=${result.reason}`,
        );
      }

      if (eligibility.get(key)?.eligible) accepted.push({ ...item, from: clientId });
    }

    console.log(
      `[RECUPERAÇÃO] varredura concluída | encontradas=${unique.length} `
      + `| elegíveis=${accepted.length} | tentativas=${attempts} | destino=fila_global_ponderada`,
    );
    return accepted;
  };

  WppClient.__safeUnreadRecoveryInstalled = true;
}

function installResetCleanup() {
  if (Store.__botActivityResetInstalled || typeof Store.resetSystem !== 'function') return;
  const originalResetSystem = Store.resetSystem.bind(Store);
  Store.resetSystem = function resetSystemWithBotActivity(...args) {
    const result = originalResetSystem(...args);
    try { BotActivity.resetAll(); } catch (_) {}
    return result;
  };
  Store.__botActivityResetInstalled = true;
}

installPersistentHumanHistory();
installBotActivityTracking();
installGratitudeReply();
installUnreadRecoveryGuard();
installResetCleanup();

console.log('[CONFIABILIDADE] agradecimentos=👍 | arte=buffer ampliado | não lidas=histórico humano protegido | recuperação=fila ponderada');

module.exports = {
  isShortAcknowledgement,
  inspectUnreadRecovery,
  _test: {
    extractMessageId,
    extractTimestampMs,
    isVisibleOutgoing,
    normalizeIntentText,
    normalizeUnreadMessage,
    unreadKey,
  },
};
