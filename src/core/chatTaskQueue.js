'use strict';

function configuredConcurrentChats(fallback) {
  const value = Number(process.env.MAX_CONCURRENT_CHATS);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class ChatTaskQueue {
  constructor({
    maxUnits = 2,
    maxConcurrentChats,
    maxQueueSize = 40,
    taskTimeoutMs = 45000,
  } = {}) {
    this.maxUnits = Math.max(1, Number(maxUnits || 1));
    this.maxConcurrentChats = Math.max(
      1,
      Number(maxConcurrentChats || configuredConcurrentChats(this.maxUnits)),
    );
    this.maxQueueSize = Math.max(1, Number(maxQueueSize || 1));
    this.taskTimeoutMs = Math.max(10, Number(taskTimeoutMs || 0));
    this.runningUnits = 0;
    this.queue = [];
    this.runningChats = new Set();
    this.sequence = 0;
  }

  stats() {
    return {
      runningUnits: this.runningUnits,
      activeChats: this.runningChats.size,
      queued: this.queue.length,
      limit: this.maxUnits,
      maxConcurrentChats: this.maxConcurrentChats,
      maxQueueSize: this.maxQueueSize,
    };
  }

  enqueue(chatId, task, options = {}) {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId) {
      return Promise.reject(new Error('chatId inválido para a fila global.'));
    }
    if (typeof task !== 'function') {
      return Promise.reject(new Error('A fila global recebeu uma tarefa inválida.'));
    }
    if (this.queue.length >= this.maxQueueSize) {
      const error = new Error(`Fila global cheia (${this.maxQueueSize}).`);
      error.code = 'QUEUE_FULL';
      error.chatId = normalizedChatId;
      return Promise.reject(error);
    }

    const timeoutMs = Math.max(10, Number(options.timeoutMs || this.taskTimeoutMs));
    const units = Math.max(0, Math.min(this.maxUnits, Number(options.units ?? 1)));

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: ++this.sequence,
        chatId: normalizedChatId,
        task,
        timeoutMs,
        units,
        resolve,
        reject,
      });
      this.processNext();
    });
  }

  processNext() {
    while (this.runningChats.size < this.maxConcurrentChats) {
      const index = this.queue.findIndex((item) => (
        !this.runningChats.has(item.chatId)
        && (this.runningUnits + item.units) <= this.maxUnits
      ));
      if (index < 0) return;

      const item = this.queue.splice(index, 1)[0];
      this.runningUnits += item.units;
      this.runningChats.add(item.chatId);

      this.runItem(item)
        .then((result) => {
          this.release(item);
          item.resolve(result);
          this.processNext();
        })
        .catch((error) => {
          this.release(item);
          item.reject(error);
          this.processNext();
        });
    }
  }

  release(item) {
    this.runningUnits = Math.max(0, this.runningUnits - item.units);
    this.runningChats.delete(item.chatId);
  }

  runItem(item) {
    let timedOut = false;
    let timeoutError = null;
    let timeoutHandle = null;

    if (item.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutError = new Error(`Timeout ao processar o chat ${item.chatId}.`);
        timeoutError.code = 'QUEUE_TIMEOUT';
        timeoutError.chatId = item.chatId;
      }, item.timeoutMs);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    }

    // O lock do chat permanece até a tarefa real terminar. JavaScript não consegue
    // cancelar uma Promise arbitrária; liberar o chat no instante do timeout faria
    // duas tarefas do mesmo cliente alterarem a sessão ao mesmo tempo.
    return Promise.resolve()
      .then(() => item.task())
      .then((result) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timedOut) throw timeoutError;
        return result;
      })
      .catch((error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timedOut && timeoutError) {
          timeoutError.cause = error;
          throw timeoutError;
        }
        throw error;
      });
  }
}

module.exports = { ChatTaskQueue };
