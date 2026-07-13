'use strict';

const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { env } = require('../config/env');
const { messages } = require('./messages');
const { sendBemVindos } = require('./mostruario');
const Store = require('../services/leadStore');
const { completePreAttendance } = require('../services/preAttendanceCompletion');
const { markContactUnread } = require('./serviceLabels');

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

function isImmediateTestCommand(text) {
  return /^\/(?:reset|reiniciar|resetarsys)$/i.test(
    String(text || '').trim().split(/\s+/)[0] || '',
  );
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

function currentResponseOptions() {
  return responseContext.getStore() || {};
}

function isGroupedResponse() {
  return !!currentResponseOptions().grouped;
}

function isWelcomeText(text) {
  return /bem-vindo\(a\) ao canal de atendimento da personalize!/i.test(String(text || ''));
}

async function interceptPreAttendance(channel, clientId, text) {
  const outgoing = String(text || '').trim();
  if (!outgoing) return { handled: true, result: false, reason: 'empty_text' };

  const stage = String(Store.getSession(clientId)?.etapa || '').trim();
  if (stage === 'plotagem_medida' && outgoing === messages.askPlotagemMedida) {
    const result = await completePreAttendance({
      channel,
      clientId,
      service: 'plotagem',
    });
    return { handled: true, result, reason: 'plotagem_completed' };
  }

  if (stage === 'outros_referencia' && outgoing === messages.askOtherReferencia) {
    const result = await completePreAttendance({
      channel,
      clientId,
      service: 'outros',
    });
    return { handled: true, result, reason: 'outros_completed' };
  }

  return { handled: false, result: null, reason: null };
}

async function markCompletedConversationUnread(channel, clientId, text) {
  if (String(text || '') !== messages.completedContactNote) return;
  const session = Store.getSession(clientId);
  if (session?.dados?.humanTakeover?.active) return;

  const result = await markContactUnread(channel, clientId, {
    source: 'pre-atendimento:letreiro-concluido',
    force: true,
  }).catch((err) => ({ marked: false, reason: err?.message || String(err) }));

  if (session) {
    session.dados = session.dados || {};
    session.dados.awaitingSeller = true;
    session.dados.unreadMarkedForSeller = Boolean(result?.marked);
    session.dados.unreadMarkedAt = result?.marked ? new Date().toISOString() : null;
    Store.saveSession(session);
  }
}

async function sendTextDirect(channel, clientId, text) {
  const chatId = normalizeChatId(clientId);
  if (typeof channel?.client?.sendText === 'function') {
    return channel.client.sendText(chatId, String(text || ''));
  }
  return channel.__rawSendText(clientId, text);
}

async function sendTextWithLinkedWelcome(channel, clientId, text, options = {}) {
  const intercepted = await interceptPreAttendance(channel, clientId, text);
  if (intercepted.handled) return intercepted.result;

  const result = await sendTextDirect(channel, clientId, text);
  if (isWelcomeText(text) && !options.skipWelcomeMedia) {
    await sendBemVindos(channel, clientId);
  }
  await markCompletedConversationUnread(channel, clientId, text);
  return result;
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
      const grouped = currentResponseOptions();
      if (grouped.grouped || options.noTyping) {
        return sendTextWithLinkedWelcome(channel, clientId, text, options);
      }

      const outgoing = String(text || '').trim();
      if (!outgoing) return false;

      const chatId = normalizeChatId(clientId);
      const started = env.enableTyping ? await startTypingCompat(channel.client, chatId) : false;
      try {
        if (started) await wait(typingDuration(text, options));
        return await sendTextWithLinkedWelcome(channel, clientId, text, options);
      } finally {
        if (started) await stopTypingCompat(channel.client, chatId);
      }
    };
  }

  if (channel.__rawSendImage) {
    channel.sendImage = async (clientId, filePath, caption = '', options = {}) => {
      const grouped = currentResponseOptions();
      if (grouped.grouped || options.noTyping) {
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
    const command = isImmediateTestCommand(summaryText);
    const shouldType = env.enableTyping && options.noTyping !== true && !command;
    const started = shouldType ? await startTypingCompat(channel.client, chatId) : false;
    let stopped = false;

    try {
      if (started) {
        await wait(typingDuration(summaryText || 'Preparando resposta', {
          ...options,
          minMs: Math.max(1000, Number(options.minMs ?? env.typingMinMs)),
        }));
        // O indicador aparece uma única vez e termina antes do bloco de balões.
        // Assim a sequência visual fica: Digitando… > mensagens agrupadas.
        await stopTypingCompat(channel.client, chatId);
        stopped = true;
      }

      return await responseContext.run({
        grouped: true,
        clientId: chatId,
        noTyping: options.noTyping === true || command,
      }, action);
    } finally {
      if (started && !stopped) await stopTypingCompat(channel.client, chatId);
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
  isWelcomeText,
  isImmediateTestCommand,
  _test: {
    interceptPreAttendance,
    markCompletedConversationUnread,
  },
};
