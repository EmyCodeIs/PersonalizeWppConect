'use strict';

class BufferManager {
  constructor({ delayMs, onFlush }) {
    this.delayMs = Math.max(500, Number(delayMs || 4500));
    this.onFlush = onFlush;
    this.map = new Map();
  }

  push(clientId, message) {
    const id = String(clientId || '').replace(/\D/g, '');
    if (!id) return;
    const item = this.map.get(id) || { messages: [], timer: null };
    item.messages.push(message);
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

module.exports = { BufferManager, mergeMessages };
