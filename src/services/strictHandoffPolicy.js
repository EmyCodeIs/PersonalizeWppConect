'use strict';

const Identity = require('./contactIdentity');
const Store = require('./leadStore');
const ConversationControl = require('./conversationControl');
const { isAllowedClient } = require('../core/allowedClient');

const DEFAULT_BOT_GUARD_MS = 8000;

const SELLER_LABELS = Object.freeze([
  Object.freeze({ seller: 'Adriano', name: 'Adriano', color: 'green', hex: '#00a884' }),
  Object.freeze({ seller: 'Ana', name: 'Ana', color: 'blue', hex: '#027eb5' }),
  Object.freeze({ seller: 'Dudu', name: 'Dudu', color: 'yellow', hex: '#f7b928' }),
]);

function serializedId(value) {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  return String(
    value?._serialized
    || value?.serialized
    || value?.remote
    || value?.remoteJid
    || value?.id
    || '',
  ).trim();
}

function normalizeChatId(value) {
  const raw = serializedId(value);
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function outgoingChatId(message = {}) {
  const candidates = [
    message?.to,
    message?.chatId,
    message?.id?.remote,
    message?.id?.remote?._serialized,
    message?.key?.remoteJid,
    message?.recipient?.id,
    message?.recipient?.id?._serialized,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeChatId(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function messageId(message = {}) {
  return String(
    message?.id?._serialized
    || message?.id?.id
    || (typeof message?.id === 'string' ? message.id : '')
    || message?.messageId
    || message?.key?.id
    || '',
  ).trim();
}

function incomingText(message = {}) {
  return String(message?.body || message?.text || '').trim();
}

function isImmediateTestCommand(text) {
  return /^\/(?:reset|reiniciar|resetarsys)$/i.test(String(text || '').trim().split(/\s+/)[0] || '');
}

function isHighConfidenceManualMessage(message = {}) {
  const fromMe = Boolean(message?.fromMe || message?.isSentByMe);
  if (!fromMe || message?.isGroupMsg || message?.isStatusV3) return false;

  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  if (/image|video|audio|ptt|document|pdf|application|sticker|list|interactive|template|button/.test(type)) {
    return false;
  }

  if (
    message?.selectedRowId
    || message?.selectedButtonId
    || message?.listResponse
    || message?.buttonsResponseMessage
    || message?.interactive
  ) {
    return false;
  }

  const text = incomingText(message);
  if (!text || text.length > 2000) return false;
  if (/^https?:\/\/\S+$/i.test(text)) return false;
  if (/^data:[^;]+;base64,/i.test(text)) return false;
  if (text.length > 500 && /^[a-z0-9+/=\s]+$/i.test(text)) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;

  return true;
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function paletteHex(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.hex || entry?.hexColor || entry?.color || entry?.value || '';
}

function nearestPaletteIndex(palette, requestedHex) {
  const wanted = hexToRgb(requestedHex);
  if (!wanted || !Array.isArray(palette) || !palette.length) return null;

  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((entry, index) => {
    const candidate = hexToRgb(paletteHex(entry));
    if (!candidate) return;
    const distance = ((candidate[0] - wanted[0]) ** 2)
      + ((candidate[1] - wanted[1]) ** 2)
      + ((candidate[2] - wanted[2]) ** 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return Number.isInteger(bestIndex) ? bestIndex : null;
}

function matchSellerLabel(items = [], palette = []) {
  for (const definition of SELLER_LABELS) {
    const expectedIndex = nearestPaletteIndex(palette, definition.hex);
    if (!Number.isInteger(expectedIndex)) continue;

    const matched = (items || []).find((item) => (
      normalizeName(item?.name) === normalizeName(definition.name)
      && Number(item?.colorIndex) === expectedIndex
    ));

    if (matched) {
      return {
        ...definition,
        id: String(matched.id || ''),
        colorIndex: Number(matched.colorIndex),
        expectedColorIndex: expectedIndex,
      };
    }
  }
  return null;
}

class RecentBotActivity {
  constructor({ guardMs = DEFAULT_BOT_GUARD_MS, now = () => Date.now() } = {}) {
    this.guardMs = Math.max(1000, Number(guardMs || DEFAULT_BOT_GUARD_MS));
    this.now = now;
    this.untilByChat = new Map();
  }

  mark(chatId, at = this.now()) {
    const normalized = normalizeChatId(chatId);
    if (!normalized) return 0;
    const until = Number(at || this.now()) + this.guardMs;
    this.untilByChat.set(normalized, until);
    return until;
  }

  remaining(chatId, at = this.now()) {
    const normalized = normalizeChatId(chatId);
    if (!normalized) return 0;
    const until = Number(this.untilByChat.get(normalized) || 0);
    const remaining = until - Number(at || this.now());
    if (remaining <= 0) {
      this.untilByChat.delete(normalized);
      return 0;
    }
    return remaining;
  }
}

async function inspectSellerLabel(client, chatId) {
  if (!client?.page?.evaluate || !chatId) return null;

  try {
    const result = await client.page.evaluate(async ({ chatId: targetChatId, definitions }) => {
      const WPP = window.WPP || null;
      const StoreWindow = window.Store || null;

      let chat = StoreWindow?.Chat?.get?.(targetChatId) || null;
      if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
        try { chat = await StoreWindow.Chat.find(targetChatId); } catch (_) {}
      }
      if (!chat) return null;

      let catalog = [];
      let palette = [];
      try {
        const value = await WPP?.labels?.getAllLabels?.();
        catalog = Array.isArray(value) ? value : Object.values(value || {});
      } catch (_) {}
      try {
        const value = await WPP?.labels?.getLabelColorPalette?.();
        palette = Array.isArray(value) ? value : Object.values(value || {});
      } catch (_) {}

      const labelStore = StoreWindow?.Label || StoreWindow?.Labels || null;
      if (typeof labelStore?.getLabelsForModel !== 'function') return null;
      const attachedRaw = labelStore.getLabelsForModel(chat) || [];
      const attached = Array.isArray(attachedRaw) ? attachedRaw : Object.values(attachedRaw || {});

      const items = attached.map((entry) => {
        const id = String(entry?.id?._serialized || entry?.id || entry?.labelId || entry || '');
        const known = catalog.find((item) => String(
          item?.id?._serialized || item?.id || item?.labelId || '',
        ) === id) || null;
        return {
          id,
          name: String(entry?.name || entry?.label || known?.name || known?.label || ''),
          colorIndex: entry?.colorIndex ?? entry?.colorId ?? entry?.color
            ?? known?.colorIndex ?? known?.colorId ?? known?.color ?? null,
        };
      }).filter((item) => item.id && item.name);

      function normalize(value) {
        return String(value || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
      }

      function rgb(hex) {
        const clean = String(hex || '').replace('#', '');
        if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
        return [
          parseInt(clean.slice(0, 2), 16),
          parseInt(clean.slice(2, 4), 16),
          parseInt(clean.slice(4, 6), 16),
        ];
      }

      function paletteValue(entry) {
        if (typeof entry === 'string') return entry;
        return entry?.hex || entry?.hexColor || entry?.color || entry?.value || '';
      }

      function nearest(hex) {
        const wanted = rgb(hex);
        if (!wanted || !palette.length) return null;
        let best = null;
        let distance = Number.POSITIVE_INFINITY;
        palette.forEach((entry, index) => {
          const candidate = rgb(paletteValue(entry));
          if (!candidate) return;
          const current = ((candidate[0] - wanted[0]) ** 2)
            + ((candidate[1] - wanted[1]) ** 2)
            + ((candidate[2] - wanted[2]) ** 2);
          if (current < distance) {
            distance = current;
            best = index;
          }
        });
        return Number.isInteger(best) ? best : null;
      }

      for (const definition of definitions) {
        const expectedIndex = nearest(definition.hex);
        if (!Number.isInteger(expectedIndex)) continue;
        const matched = items.find((item) => (
          normalize(item.name) === normalize(definition.name)
          && Number(item.colorIndex) === expectedIndex
        ));
        if (matched) {
          return {
            ...definition,
            id: matched.id,
            colorIndex: Number(matched.colorIndex),
            expectedColorIndex: expectedIndex,
          };
        }
      }

      return null;
    }, { chatId, definitions: SELLER_LABELS });

    return result || null;
  } catch (err) {
    console.warn('[HANDOFF] não foi possível conferir etiqueta de vendedor:', err?.message || err);
    return null;
  }
}

function applySellerLabelHandoff(clientId, sellerLabel) {
  if (!clientId || !sellerLabel?.seller) return null;
  const session = Store.getSession(clientId);
  if (!session) return null;

  const current = session.dados?.humanTakeover;
  if (
    current?.active
    && current?.source === 'seller_label'
    && normalizeName(current?.sellerName) === normalizeName(sellerLabel.seller)
  ) {
    return session;
  }

  const saved = ConversationControl.beginSellerTakeover(clientId, {
    at: Date.now(),
    messageId: `seller-label:${sellerLabel.id || sellerLabel.seller}`,
    text: `Etiqueta de vendedor aplicada: ${sellerLabel.seller}`,
  });
  if (!saved) return null;

  saved.dados = saved.dados || {};
  saved.dados.humanTakeover = {
    ...(saved.dados.humanTakeover || {}),
    active: true,
    source: 'seller_label',
    sellerName: sellerLabel.seller,
    sellerColor: sellerLabel.color,
    sellerLabelId: sellerLabel.id || null,
    sellerLabelColorIndex: sellerLabel.colorIndex,
  };
  saved.dados.botControl = {
    ...(saved.dados.botControl || {}),
    reason: 'seller_label',
    sellerName: sellerLabel.seller,
  };
  Store.saveSession(saved);

  console.log(
    `[HANDOFF] etiqueta de vendedor detectada: ${sellerLabel.seller} `
    + `(${sellerLabel.color}) em ${clientId}`,
  );
  return saved;
}

function installStrictHandoffPolicy(client, { guardMs = DEFAULT_BOT_GUARD_MS } = {}) {
  if (!client || client.__strictHandoffPolicyInstalled) return client;
  const activity = new RecentBotActivity({ guardMs });
  const trackedSendMethods = ['sendText', 'sendImage', 'sendFile', 'sendListMessage', 'sendList'];

  for (const method of trackedSendMethods) {
    if (typeof client?.[method] !== 'function') continue;
    const original = client[method].bind(client);
    client[method] = async (...args) => {
      activity.mark(args[0]);
      return original(...args);
    };
  }

  if (typeof client.onAnyMessage === 'function') {
    const originalOnAnyMessage = client.onAnyMessage.bind(client);
    const scheduled = new Set();

    client.onAnyMessage = (callback) => originalOnAnyMessage(async (message) => {
      const fromMe = Boolean(message?.fromMe || message?.isSentByMe);
      if (!fromMe) return callback(message);

      if (!isHighConfidenceManualMessage(message)) {
        return undefined;
      }

      const chatId = outgoingChatId(message);
      if (!chatId || /@g\.us$/i.test(chatId)) return undefined;

      const remaining = activity.remaining(chatId);
      if (remaining <= 0) return callback(message);

      const key = messageId(message) || `${chatId}:${incomingText(message)}:${message?.timestamp || ''}`;
      if (scheduled.has(key)) return undefined;
      scheduled.add(key);

      const timer = setTimeout(() => {
        scheduled.delete(key);
        Promise.resolve(callback(message)).catch((err) => {
          console.warn('[HANDOFF] falha ao reavaliar mensagem manual:', err?.message || err);
        });
      }, remaining + 120);
      timer.unref?.();
      return undefined;
    });
  }

  if (typeof client.onMessage === 'function') {
    const originalOnMessage = client.onMessage.bind(client);
    client.onMessage = (callback) => originalOnMessage(async (message) => {
      const fromMe = Boolean(message?.fromMe || message?.isSentByMe);
      const from = normalizeChatId(message?.from || message?.chatId || message?.sender?.id);
      const text = incomingText(message);

      if (!fromMe && from && !message?.isGroupMsg && !isImmediateTestCommand(text)) {
        try {
          const identity = Identity.registerContact({ chatId: from, raw: message });
          const canonicalChatId = identity?.primaryChatId || from;
          const allowed = isAllowedClient({ from: canonicalChatId, raw: message });
          if (allowed.allowed) {
            Store.getSession(canonicalChatId);
            const sellerLabel = await inspectSellerLabel(client, canonicalChatId);
            if (sellerLabel) applySellerLabelHandoff(canonicalChatId, sellerLabel);
          }
        } catch (err) {
          console.warn('[HANDOFF] falha ao conferir vendedor responsável:', err?.message || err);
        }
      }

      return callback(message);
    });
  }

  client.__strictHandoffPolicyInstalled = true;
  client.__strictHandoffActivity = activity;
  return client;
}

function patchWppConnect(wppconnect) {
  if (!wppconnect || wppconnect.__strictHandoffCreatePatched) return wppconnect;
  if (typeof wppconnect.create !== 'function') return wppconnect;

  const originalCreate = wppconnect.create.bind(wppconnect);
  wppconnect.create = async (...args) => {
    const client = await originalCreate(...args);
    return installStrictHandoffPolicy(client);
  };
  wppconnect.__strictHandoffCreatePatched = true;
  return wppconnect;
}

module.exports = {
  DEFAULT_BOT_GUARD_MS,
  SELLER_LABELS,
  RecentBotActivity,
  applySellerLabelHandoff,
  incomingText,
  inspectSellerLabel,
  installStrictHandoffPolicy,
  isHighConfidenceManualMessage,
  matchSellerLabel,
  nearestPaletteIndex,
  normalizeChatId,
  outgoingChatId,
  patchWppConnect,
};