'use strict';

const Store = require('./leadStore');
const { env } = require('../config/env');

const HOUR_MS = 60 * 60 * 1000;

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function configuredSilenceHours() {
  const value = Number(env.botReentryAfterHours);
  return Number.isFinite(value) && value > 0 ? value : 72;
}

function calculateSilenceUntil(startedAt, hours = configuredSilenceHours()) {
  const start = toTimestamp(startedAt) || Date.now();
  return new Date(start + (hours * HOUR_MS)).toISOString();
}

function isTestCommand(text) {
  return /^\/(?:reset|reiniciar|resetarsys)$/i.test(String(text || '').trim().split(/\s+/)[0] || '');
}

function getControl(session) {
  const value = session?.dados?.botControl;
  return value && typeof value === 'object' ? value : null;
}

function isSilenceActive(control, now = Date.now()) {
  return Boolean(
    control?.state === 'silent'
    && toTimestamp(control.silenceUntil) > now,
  );
}

function applySilence(session, {
  reason,
  startedAt = nowIso(),
  sourceMessageId = null,
  sourceText = null,
} = {}) {
  if (!session) return null;
  session.dados = session.dados || {};
  const previous = getControl(session) || {};
  const startIso = nowIso(toTimestamp(startedAt) || Date.now());
  const silenceUntil = calculateSilenceUntil(startIso);

  session.dados.botControl = {
    ...previous,
    state: 'silent',
    reason: String(reason || 'manual').trim() || 'manual',
    startedAt: startIso,
    silenceUntil,
    sourceMessageId: sourceMessageId ? String(sourceMessageId) : null,
    sourceText: sourceText ? String(sourceText).slice(0, 500) : null,
    lastClientMessageAt: previous.lastClientMessageAt || null,
    lastSellerMessageAt: reason === 'seller_message' ? startIso : previous.lastSellerMessageAt || null,
    updatedAt: nowIso(),
  };

  if (reason === 'seller_message') {
    session.dados.humanTakeover = {
      active: true,
      assumedAt: startIso,
      lastSellerMessageAt: startIso,
      sourceMessageId: sourceMessageId ? String(sourceMessageId) : null,
    };
  }

  return Store.saveSession(session);
}

function beginSellerTakeover(clientId, {
  at = Date.now(),
  messageId = null,
  text = null,
} = {}) {
  const session = Store.getSession(clientId);
  if (!session) return null;
  const saved = applySilence(session, {
    reason: 'seller_message',
    startedAt: at,
    sourceMessageId: messageId,
    sourceText: text,
  });
  Store.appendLead({
    event: 'seller_takeover',
    clientId: saved?.id || clientId,
    etapa: saved?.etapa || null,
    sellerMessageAt: nowIso(at),
    silenceUntil: saved?.dados?.botControl?.silenceUntil || null,
  });
  return saved;
}

function ensureCompletionSilence(clientId) {
  const session = Store.getSession(clientId);
  if (!session || (!session.completed && !session.dados?.botDone)) return null;
  const existing = getControl(session);
  if (existing?.reason === 'completed' && existing?.silenceUntil) return session;
  return applySilence(session, {
    reason: 'completed',
    startedAt: session.dados?.completedAt || session.updatedAt || Date.now(),
  });
}

function preserveBasicData(previous, fresh) {
  const source = previous?.dados || {};
  fresh.dados = fresh.dados || {};
  for (const key of ['nome', 'telefone', 'nomeOrigem']) {
    if (source[key]) fresh.dados[key] = source[key];
  }
  fresh.dados.previousAttendance = {
    closedAt: source.completedAt || null,
    silenceReason: source.botControl?.reason || null,
    silenceEndedAt: source.botControl?.silenceUntil || null,
  };
  return fresh;
}

function evaluateIncoming(clientId, {
  at = Date.now(),
  text = '',
} = {}) {
  if (env.enableTestCommands && isTestCommand(text)) {
    return { action: 'process', reason: 'test_command' };
  }

  let session = Store.getSession(clientId);
  if (!session) return { action: 'process', reason: 'no_session' };

  if ((session.completed || session.dados?.botDone) && !getControl(session)) {
    session = ensureCompletionSilence(clientId) || session;
  }

  const control = getControl(session);
  if (!control || control.state !== 'silent') {
    return { action: 'process', reason: 'active_bot' };
  }

  const until = toTimestamp(control.silenceUntil);
  if (until > at) {
    session.dados.botControl.lastClientMessageAt = nowIso(at);
    session.dados.botControl.updatedAt = nowIso(at);
    Store.saveSession(session);
    return {
      action: 'ignore',
      reason: control.reason,
      silenceUntil: control.silenceUntil,
      remainingMs: until - at,
    };
  }

  const previous = JSON.parse(JSON.stringify(session));
  let fresh = Store.resetSession(clientId);
  fresh = preserveBasicData(previous, fresh);
  Store.saveSession(fresh);
  Store.appendLead({
    event: 'new_contact_after_silence',
    clientId: fresh.id,
    previousEtapa: previous.etapa || null,
    previousCompletedAt: previous.dados?.completedAt || null,
    previousSilenceReason: control.reason || null,
    reopenedAt: nowIso(at),
  });

  return {
    action: 'process',
    reason: 'silence_expired_new_contact',
    reset: true,
    previousReason: control.reason,
  };
}

function shouldBlockBotOutbound(clientId, now = Date.now()) {
  const session = Store.getSession(clientId);
  const control = getControl(session);
  return isSilenceActive(control, now);
}

function status(clientId, now = Date.now()) {
  const session = Store.getSession(clientId);
  const control = getControl(session);
  return {
    active: isSilenceActive(control, now),
    reason: control?.reason || null,
    silenceUntil: control?.silenceUntil || null,
    humanTakeover: Boolean(session?.dados?.humanTakeover?.active),
  };
}

module.exports = {
  beginSellerTakeover,
  ensureCompletionSilence,
  evaluateIncoming,
  shouldBlockBotOutbound,
  status,
  _test: {
    HOUR_MS,
    applySilence,
    calculateSilenceUntil,
    configuredSilenceHours,
    getControl,
    isSilenceActive,
    isTestCommand,
    toTimestamp,
  },
};
