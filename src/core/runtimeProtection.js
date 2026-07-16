'use strict';

const { env } = require('../config/env');

const state = {
  level: 'normal',
  reasons: [],
  activeSince: null,
  lastSnapshot: null,
  timer: null,
};

function computeQueueThreshold(ratio, fallback) {
  const maxQueueSize = Math.max(1, Number(env.maxQueueSize || 1));
  return Math.max(1, Math.min(maxQueueSize, Math.ceil(maxQueueSize * ratio) || fallback));
}

function pressureConfig() {
  const elevatedQueue = Math.max(1, Number(env.runtimePressureQueueThreshold || computeQueueThreshold(0.35, 6)));
  const criticalQueue = Math.max(elevatedQueue, Number(env.runtimePressureCriticalQueueThreshold || computeQueueThreshold(0.65, 12)));

  return {
    enabled: env.runtimeProtectionEnabled !== false,
    checkMs: Math.max(5000, Number(env.runtimeProtectionCheckMs || 15000)),
    cooldownMs: Math.max(10000, Number(env.runtimePressureCooldownMs || 60000)),
    elevatedQueue,
    criticalQueue,
    elevatedRssMb: Math.max(128, Number(env.runtimePressureRssMb || 350)),
    criticalRssMb: Math.max(256, Number(env.runtimePressureCriticalRssMb || 550)),
  };
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round((Number(usage?.rss || 0) / (1024 * 1024)) * 10) / 10,
    heapUsedMb: Math.round((Number(usage?.heapUsed || 0) / (1024 * 1024)) * 10) / 10,
    heapTotalMb: Math.round((Number(usage?.heapTotal || 0) / (1024 * 1024)) * 10) / 10,
  };
}

function normalizeStats(stats = {}) {
  return {
    runningUnits: Math.max(0, Number(stats.runningUnits || 0)),
    queued: Math.max(0, Number(stats.queued || 0)),
    limit: Math.max(1, Number(stats.limit || env.queueMaxUnits || 1)),
    activeChats: Math.max(0, Number(stats.activeChats || 0)),
    maxConcurrentChats: Math.max(1, Number(stats.maxConcurrentChats || env.maxConcurrentChats || 1)),
  };
}

function decideLevel(snapshot) {
  const config = pressureConfig();
  const reasons = [];
  let level = 'normal';

  if (snapshot.stats.queued >= config.elevatedQueue) {
    level = 'elevated';
    reasons.push(`fila=${snapshot.stats.queued}`);
  }

  if (snapshot.memory.rssMb >= config.elevatedRssMb) {
    level = 'elevated';
    reasons.push(`rss=${snapshot.memory.rssMb}MB`);
  }

  if (snapshot.stats.queued >= config.criticalQueue) {
    level = 'critical';
    reasons.push(`filaCrítica=${snapshot.stats.queued}`);
  }

  if (snapshot.memory.rssMb >= config.criticalRssMb) {
    level = 'critical';
    reasons.push(`rssCrítico=${snapshot.memory.rssMb}MB`);
  }

  return { level, reasons };
}

function describeSnapshot(snapshot) {
  return `fila=${snapshot.stats.queued}/${env.maxQueueSize} unidades=${snapshot.stats.runningUnits}/${snapshot.stats.limit} chats=${snapshot.stats.activeChats}/${snapshot.stats.maxConcurrentChats} rss=${snapshot.memory.rssMb}MB heap=${snapshot.memory.heapUsedMb}/${snapshot.memory.heapTotalMb}MB`;
}

function snapshot(taskQueue = null) {
  const stats = normalizeStats(typeof taskQueue?.stats === 'function' ? taskQueue.stats() : state.lastSnapshot?.stats);
  const memory = memorySnapshot();
  const value = {
    at: Date.now(),
    stats,
    memory,
  };
  state.lastSnapshot = value;
  return value;
}

function transition(nextLevel, reasons, currentSnapshot) {
  const now = Date.now();
  const config = pressureConfig();
  const wasActive = state.level !== 'normal';
  const wantsCooldown = wasActive
    && nextLevel === 'normal'
    && state.activeSince
    && (now - state.activeSince) < config.cooldownMs;

  if (wantsCooldown) return state.level;

  if (nextLevel === state.level) {
    state.reasons = reasons;
    if (nextLevel === 'normal') state.activeSince = null;
    return state.level;
  }

  state.level = nextLevel;
  state.reasons = reasons;
  state.activeSince = nextLevel === 'normal' ? null : now;

  if (nextLevel === 'normal') {
    console.log(`[AUTOPROTEÇÃO] pressão normalizada | ${describeSnapshot(currentSnapshot)}`);
  } else {
    console.warn(
      `[AUTOPROTEÇÃO] modo ${nextLevel} ativado | motivos=${reasons.join(', ') || 'pressão interna'} `
      + `| ${describeSnapshot(currentSnapshot)}`,
    );
  }

  return state.level;
}

function evaluate(taskQueue = null) {
  if (!pressureConfig().enabled) return state.level;
  const currentSnapshot = snapshot(taskQueue);
  const decision = decideLevel(currentSnapshot);
  return transition(decision.level, decision.reasons, currentSnapshot);
}

function startRuntimeProtection(taskQueue = null) {
  if (!pressureConfig().enabled || state.timer) return;
  state.timer = setInterval(() => {
    try { evaluate(taskQueue); } catch (error) {
      console.warn('[AUTOPROTEÇÃO] falha ao avaliar pressão interna:', error?.message || error);
    }
  }, pressureConfig().checkMs);
  state.timer.unref?.();
  evaluate(taskQueue);
}

function getRuntimeProtectionState() {
  return {
    level: state.level,
    active: state.level !== 'normal',
    reasons: [...(state.reasons || [])],
    activeSince: state.activeSince,
    snapshot: state.lastSnapshot,
  };
}

function shouldSuppressTyping() {
  return getRuntimeProtectionState().active;
}

function shouldSkipNonCriticalRepairs() {
  return getRuntimeProtectionState().active;
}

function bufferDelayMultiplier() {
  if (state.level === 'critical') return 1.6;
  if (state.level === 'elevated') return 1.35;
  return 1;
}

module.exports = {
  bufferDelayMultiplier,
  evaluate,
  getRuntimeProtectionState,
  shouldSkipNonCriticalRepairs,
  shouldSuppressTyping,
  startRuntimeProtection,
};
