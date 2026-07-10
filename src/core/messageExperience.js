'use strict';

const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { env } = require('../config/env');

const responseContext = new AsyncLocalStorage();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function typingDuration(text, options = {}) {
  const min = Math.max(0, Number(options.minMs ?? env.typingMinMs));
  const max = Math.max(min, Number(options.maxMs ?? env.typingMaxMs));
  const estimated = Math.round((String(text || '').length / env.typingCharsPerSecond) * 1000);
  return Math.max(min, Math.min(max, estimated || min));
}

async function startTypingCompat(client, chatId) {
  const attempts = [
    async () => {
      if (typeof client?.startTyping !== 'function') return false;
      await client.startTyping(chatId);
      return true;
    },
    async () => {
      if (typeof client?.setChatState !== 'function') return false;
      await client.setChatState(chatId, 0);
      return true;
    },
  ];
  for (const attempt of attempts) {
    try {
      if (await attempt()) return true;
    } catch (_) {}
  }
  return false;
}

async function stopTypingCompat(client, chatId) {
  const attempts = [
    async () => {
      if (typeof client?.stopTyping !== 'function') return false;
      await client.stopTyping(chatId);
      return true;
    },
    async () => {
      if (typeof client?.setChatState !== 'function') return false;
      await client.setChatState(chatId, 2);
      return true;
    },
  ];
  for (const attempt of attempts) {
    try {
      if (await attempt()) return true;
    } catch (_) {}
  }
  return false;
}

function isGroupedResponse() {
  return !!responseContext.getStore()?.grouped;
}

async function sendTextDirect(channel, clientId, text) {
  const chatId = normalizeChatId(clientId);
  if (typeof channel?.client?.sendText === 'function') {
    return channel.client.sendText(chatId, String(text || ''));
  }
  return channel.__rawSendText(clientId, text);
}

async function sendImageDirect(channel, clientId, filePath, caption = '') {
  const chatId = normalizeChatId(clientId);
  const fullPath = path.resolve(process.cwd(), filePath);
  if (typeof channel?.client?.sendImage === 'function') {
    return channel.client.sendImage(chatId, fullPath, path.basename(fullPath), String(caption || ''));
  }
  return channel.__rawSendImage(clientId, filePath, caption);
}

function installMessageExperience(channel) {
  if (!channel || channel.__messageExperienceInstalled) return channel;

  channel.__rawSendText = typeof channel.sendText === 'function' ? channel.sendText.bind(channel) : null;
  channel.__rawSendImage = typeof channel.sendImage === 'function' ? channel.sendImage.bind(channel) : null;

  if (channel.__rawSendText) {
    channel.sendText = async (clientId, text, options = {}) => {
      if (isGroupedResponse() || options.noTyping) {
        return sendTextDirect(channel, clientId, text);
      }

      const chatId = normalizeChatId(clientId);
      const started = env.enableTyping ? await startTypingCompat(channel.client, chatId) : false;
      try {
        if (started) await wait(typingDuration(text, options));
        return await sendTextDirect(channel, clientId, text);
      } finally {
        if (started) await stopTypingCompat(channel.client, chatId);
      }
    };
  }

  if (channel.__rawSendImage) {
    channel.sendImage = async (clientId, filePath, caption = '', options = {}) => {
      if (isGroupedResponse() || options.noTyping) {
        return sendImageDirect(channel, clientId, filePath, caption);
      }

      const chatId = normalizeChatId(clientId);
      const started = env.enableTyping ? await startTypingCompat(channel.client, chatId) : false;
      try {
        if (started) await wait(typingDuration(caption || 'Enviando imagem', options));
        return await sendImageDirect(channel, clientId, filePath, caption);
      } finally {
        if (started) await stopTypingCompat(channel.client, chatId);
      }
    };
  }

  channel.startTyping = async (clientId) => startTypingCompat(channel.client, normalizeChatId(clientId));
  channel.stopTyping = async (clientId) => stopTypingCompat(channel.client, normalizeChatId(clientId));

  channel.runResponseGroup = async (clientId, summaryText, action, options = {}) => {
    if (typeof action !== 'function') return null;
    if (isGroupedResponse()) return action();

    const chatId = normalizeChatId(clientId);
    const started = env.enableTyping ? await startTypingCompat(channel.client, chatId) : false;
    try {
      if (started) await wait(typingDuration(summaryText || 'Preparando resposta', options));
      return await responseContext.run({ grouped: true, clientId: chatId }, action);
    } finally {
      if (started) await stopTypingCompat(channel.client, chatId);
    }
  };

  channel.__messageExperienceInstalled = true;
  return channel;
}

module.exports = {
  installMessageExperience,
  startTypingCompat,
  stopTypingCompat,
  typingDuration,
  isGroupedResponse,
};
