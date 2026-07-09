'use strict';

function normalizeBufferId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  // Preserva IDs reais do WhatsApp, incluindo @c.us, @lid e @g.us.
  // Converter para apenas dígitos quebra conversas novas/LID e causa erro "No LID for user" ao responder.
  return raw;
}

class BufferManager {
  constructor({ delayMs, onFlush }) {
    this.delayMs = Math.max(500, Number(delayMs || 4500));
    this.onFlush = onFlush;
    this.map = new Map();
  }

  push(clientId, message) {
    const id = normalizeBufferId(clientId);
    if (!id) return;
    const item = this.map.get(id) || { messages: [], timer: null };
    item.messages.push({ ...message, chatId: id });
    if (item.timer) clearTimeout(item.timer);
    item.timer = setTimeout(async () => {
      const current = this.map.get(id);
      this.map.delete(id);
      if (!current?.messages?.length) return;
      await this.onFlush(id, current.messages).catch((err) => {
        console.error('[BUFFER] flush error:', err?.message || err);
      });
    }, this.delayMs);
    if (typeof item.timer.unref === 'function') item.timer.unref();
    this.map.set(id, item);
  }
}

function mergeMessages(messages = []) {
  return messages
    .map((msg) => msg?.text || msg?.body || msg?.caption || '')
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .join('\n');
}

module.exports = { BufferManager, mergeMessages, normalizeBufferId };
