'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 45000;
const INTERACTIVE_FALLBACK_MS = 5000;
const MEDIA_FALLBACK_MS = 3000;

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

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

function messageId(value) {
  return String(
    value?.id?._serialized
    || value?.id?.id
    || (typeof value?.id === 'string' ? value.id : '')
    || value?.messageId
    || value?.key?.id
    || value?.msg?.id?._serialized
    || '',
  ).trim();
}

function outgoingChatIds(message = {}) {
  const candidates = [
    message?.to,
    message?.chatId,
    message?.id?.remote,
    message?.id?.remote?._serialized,
    message?.key?.remoteJid,
    message?.recipient?.id,
    message?.recipient?.id?._serialized,
    message?.from,
  ];

  return [...new Set(candidates.map(normalizeChatId).filter(Boolean))];
}

function outgoingChatId(message = {}) {
  return outgoingChatIds(message)[0] || '';
}

function messageKind(message = {}) {
  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  if (/image|sticker/.test(type)) return 'image';
  if (/document|pdf|application/.test(type)) return 'document';
  if (/list|interactive|template|button/.test(type)) return 'list';
  if (/video/.test(type)) return 'video';
  if (/audio|ptt/.test(type)) return 'audio';
  return 'text';
}

function messageTexts(message = {}) {
  return [
    message?.body,
    message?.caption,
    message?.text,
    message?.content,
    message?.description,
    message?.title,
  ].map(normalizeText).filter(Boolean);
}

function tokenId() {
  return crypto.randomBytes(8).toString('hex');
}

class OutboundMessageTracker {
  constructor({ ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttlMs = Math.max(5000, Number(ttlMs || DEFAULT_TTL_MS));
    this.pending = new Map();
    this.byMessageId = new Map();
  }

  cleanup(now = Date.now()) {
    for (const [id, token] of this.pending.entries()) {
      if (token.expiresAt <= now) this.pending.delete(id);
    }
    for (const [id, record] of this.byMessageId.entries()) {
      if (Number(record?.expiresAt || 0) <= now) this.byMessageId.delete(id);
    }
  }

  begin({ chatId, kind = 'text', texts = [] } = {}) {
    this.cleanup();
    const createdAt = Date.now();
    const token = {
      id: tokenId(),
      chatId: normalizeChatId(chatId),
      kind: String(kind || 'text').toLowerCase(),
      texts: [...new Set((texts || []).map(normalizeText).filter(Boolean))],
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.pending.set(token.id, token);
    return token;
  }

  rememberMessageId(id, tokenIdValue = null) {
    const normalized = String(id || '').trim();
    if (!normalized) return;
    this.byMessageId.set(normalized, {
      tokenId: tokenIdValue || null,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  bindResult(token, result) {
    if (!token) return;
    const ids = [
      messageId(result),
      messageId(result?.message),
      messageId(result?.msg),
    ].filter(Boolean);
    for (const id of ids) this.rememberMessageId(id, token.id);
  }

  cancel(token) {
    if (token?.id) this.pending.delete(token.id);
  }

  consume(message = {}) {
    const now = Date.now();
    this.cleanup(now);
    const id = messageId(message);

    // O mesmo envio pode aparecer mais de uma vez no onAnyMessage.
    // Mantemos o ID reconhecido até o TTL expirar para que eventos duplicados
    // do próprio bot nunca sejam classificados como atendimento humano.
    if (id && this.byMessageId.has(id)) {
      const record = this.byMessageId.get(id);
      if (record?.tokenId) this.pending.delete(record.tokenId);
      return true;
    }

    const chatIds = outgoingChatIds(message);
    const kind = messageKind(message);
    const texts = messageTexts(message);

    const candidates = [...this.pending.values()]
      .filter((token) => token.chatId && chatIds.includes(token.chatId))
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const token of candidates) {
      const ageMs = now - token.createdAt;
      const kindCompatible = token.kind === kind
        || (['image', 'document', 'video', 'audio', 'list'].includes(token.kind) && kind === 'text');
      if (!kindCompatible) continue;

      const exactTextMatch = token.texts.length > 0
        && token.texts.some((expected) => texts.some((actual) => (
          actual === expected
          || actual.includes(expected)
          || expected.includes(actual)
        )));

      // Imagens sem legenda podem ser serializadas como evento de texto vazio.
      // A janela é curta e só vale enquanto existe um envio programático pendente.
      const emptyMediaMatch = ['image', 'document', 'video', 'audio'].includes(token.kind)
        && texts.length === 0
        && ageMs <= MEDIA_FALLBACK_MS;

      // Listas podem voltar pelo WhatsApp como `chat` com conteúdo interno
      // diferente do payload enviado. O registro foi criado antes do envio.
      const recentInteractiveMatch = token.kind === 'list'
        && ageMs <= INTERACTIVE_FALLBACK_MS;

      if (!exactTextMatch && !emptyMediaMatch && !recentInteractiveMatch) continue;

      if (id) this.rememberMessageId(id, token.id);
      this.pending.delete(token.id);
      return true;
    }

    return false;
  }
}

module.exports = {
  OutboundMessageTracker,
  normalizeChatId,
  normalizeText,
  messageId,
  outgoingChatId,
  outgoingChatIds,
  messageKind,
  messageTexts,
  _test: {
    DEFAULT_TTL_MS,
    INTERACTIVE_FALLBACK_MS,
    MEDIA_FALLBACK_MS,
  },
};
