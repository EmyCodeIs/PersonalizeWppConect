'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 45000;
const INTERACTIVE_FALLBACK_MS = 5000;

function normalizeChatId(value) {
  const raw = String(value || '').trim();
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
    || value?.id
    || value?.messageId
    || value?.key?.id
    || '',
  ).trim();
}

function outgoingChatId(message = {}) {
  return normalizeChatId(
    message?.to
    || message?.chatId
    || message?.recipient?.id
    || message?.from,
  );
}

function messageKind(message = {}) {
  const type = String(message?.type || message?.mimetype || message?.mediaType || '').toLowerCase();
  if (/image/.test(type)) return 'image';
  if (/document|pdf|application/.test(type)) return 'document';
  if (/list|interactive/.test(type)) return 'list';
  if (/video/.test(type)) return 'video';
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
    const token = {
      id: tokenId(),
      chatId: normalizeChatId(chatId),
      kind: String(kind || 'text'),
      texts: [...new Set((texts || []).map(normalizeText).filter(Boolean))],
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.pending.set(token.id, token);
    return token;
  }

  bindResult(token, result) {
    if (!token) return;
    const ids = [
      messageId(result),
      messageId(result?.message),
      messageId(result?.msg),
    ].filter(Boolean);
    for (const id of ids) {
      this.byMessageId.set(id, {
        tokenId: token.id,
        expiresAt: Date.now() + this.ttlMs,
      });
    }
  }

  cancel(token) {
    if (token?.id) this.pending.delete(token.id);
  }

  consume(message = {}) {
    const now = Date.now();
    this.cleanup(now);
    const id = messageId(message);
    if (id && this.byMessageId.has(id)) {
      const record = this.byMessageId.get(id);
      this.byMessageId.delete(id);
      if (record?.tokenId) this.pending.delete(record.tokenId);
      return true;
    }

    const chatId = outgoingChatId(message);
    const kind = messageKind(message);
    const texts = messageTexts(message);

    const candidates = [...this.pending.values()]
      .filter((token) => token.chatId && token.chatId === chatId)
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const token of candidates) {
      const kindCompatible = token.kind === kind
        || (token.kind === 'document' && kind === 'text')
        || (token.kind === 'list' && kind === 'text');
      if (!kindCompatible) continue;

      const exactTextMatch = token.texts.length > 0
        && token.texts.some((expected) => texts.some((actual) => (
          actual === expected
          || actual.includes(expected)
          || expected.includes(actual)
        )));
      const emptyMediaMatch = token.texts.length === 0 && kind !== 'text';
      const recentInteractiveMatch = token.kind !== 'text'
        && (now - token.createdAt) <= INTERACTIVE_FALLBACK_MS;

      if (!exactTextMatch && !emptyMediaMatch && !recentInteractiveMatch) continue;

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
  messageKind,
  messageTexts,
  _test: {
    DEFAULT_TTL_MS,
    INTERACTIVE_FALLBACK_MS,
  },
};
