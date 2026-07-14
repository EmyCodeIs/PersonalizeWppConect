'use strict';

class ChatTaskQueue {
  constructor({ maxUnits = 4, maxQueueSize = 40, taskTimeoutMs = 45000 } = {}) {
    this.maxUnits = Math.max(1, Number(maxUnits || 1));
    this.maxQueueSize = Math.max(1, Number(maxQueueSize || 1));
    this.taskTimeoutMs = Math.max(5000, Number(taskTimeoutMs || 0));
    this.runningUnits = 0;
    this.queue = [];
    this.runningChats = new Set();
    this.sequence = 0;
  }

  stats() {
    return {
      running: this.runningChats.size,
      runningUnits: this.runningUnits,
      queued: this.queue.length,
      limit: this.maxUnits,
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

    const timeoutMs = Math.max(5000, Number(options.timeoutMs || this.taskTimeoutMs));
    const units = Math.max(1, Number(options.units || 1));
    if (units > this.maxUnits) {
      const error = new Error(`Tarefa do chat ${normalizedChatId} exige ${units} unidades, acima do limite ${this.maxUnits}.`);
      error.code = 'QUEUE_UNITS_EXCEEDED';
      error.chatId = normalizedChatId;
      error.units = units;
      return Promise.reject(error);
    }

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
    while (this.runningUnits < this.maxUnits) {
      const index = this.queue.findIndex((item) => {
        if (this.runningChats.has(item.chatId)) return false;
        return (this.runningUnits + item.units) <= this.maxUnits;
      });
      if (index < 0) return;

      const item = this.queue.splice(index, 1)[0];
      this.runningUnits += item.units;
      this.runningChats.add(item.chatId);

      this.runItem(item)
        .then((result) => {
          this.runningUnits = Math.max(0, this.runningUnits - item.units);
          this.runningChats.delete(item.chatId);
          item.resolve(result);
          this.processNext();
        })
        .catch((error) => {
          this.runningUnits = Math.max(0, this.runningUnits - item.units);
          this.runningChats.delete(item.chatId);
          item.reject(error);
          this.processNext();
        });
    }
  }

  runItem(item) {
    const taskPromise = Promise.resolve().then(() => item.task());
    if (!item.timeoutMs) return taskPromise;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const error = new Error(`Timeout ao processar o chat ${item.chatId}.`);
        error.code = 'QUEUE_TIMEOUT';
        error.chatId = item.chatId;
        reject(error);
      }, item.timeoutMs);

      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

      taskPromise
        .then((result) => {
          clearTimeout(timeoutHandle);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }
}

module.exports = { ChatTaskQueue };
