'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./contactIdentity');

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_PATH = process.env.SESSIONS_STORE_PATH
  ? path.resolve(process.cwd(), process.env.SESSIONS_STORE_PATH)
  : path.join(DATA_DIR, 'sessions.json');
const LEADS_PATH = process.env.LEADS_STORE_PATH
  ? path.resolve(process.cwd(), process.env.LEADS_STORE_PATH)
  : path.join(DATA_DIR, 'leads.jsonl');
const DEFAULT_ORDER_NUMBER = (() => {
  const value = Number(process.env.ORDER_NUMBER_START || 70001);
  return Number.isInteger(value) && value > 0 ? value : 70001;
})();

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureParentDir(filePath);
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(`${filePath}.tmp`, filePath);
}

const state = readJson(SESSIONS_PATH, {
  sessions: {},
  lastSavedAt: null,
  nextOrderNumber: DEFAULT_ORDER_NUMBER,
});
if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
if (!Number.isInteger(Number(state.nextOrderNumber)) || Number(state.nextOrderNumber) <= 0) {
  state.nextOrderNumber = DEFAULT_ORDER_NUMBER;
} else {
  state.nextOrderNumber = Number(state.nextOrderNumber);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeClientId(clientId) {
  return Identity.getSessionKey(clientId);
}

function createSession(id, chatId) {
  const identity = Identity.resolveContact(chatId || id);
  return {
    id,
    clientId: id,
    chatId: identity?.primaryChatId || String(chatId || '').trim() || null,
    contactIdentity: identity || null,
    etapa: 'inicio',
    dados: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completed: false,
  };
}

function migrateSession(session, id, chatId) {
  const next = session && typeof session === 'object' ? session : createSession(id, chatId);
  const identity = Identity.resolveContact(chatId || next.chatId || id);
  next.id = id;
  next.clientId = id;
  next.chatId = identity?.primaryChatId || next.chatId || String(chatId || '').trim() || null;
  next.contactIdentity = identity || next.contactIdentity || null;
  next.etapa = next.etapa || next.step || 'inicio';
  next.dados = next.dados || next.data || {};
  next.createdAt = next.createdAt || nowIso();
  next.updatedAt = next.updatedAt || nowIso();
  if (typeof next.completed !== 'boolean') next.completed = Boolean(next.dados?.botDone);
  return next;
}

function getSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  state.sessions[id] = migrateSession(state.sessions[id], id, clientId);
  return state.sessions[id];
}

function saveSession(session) {
  if (!session?.clientId && !session?.id && !session?.chatId) return null;
  const sourceId = session.chatId || session.clientId || session.id;
  const id = normalizeClientId(sourceId);
  const next = migrateSession(session, id, sourceId);
  next.updatedAt = nowIso();
  state.sessions[id] = next;
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);
  return next;
}

function ensureOrderNumber(session) {
  if (!session?.clientId && !session?.id && !session?.chatId) return null;
  const sourceId = session.chatId || session.clientId || session.id;
  const id = normalizeClientId(sourceId);
  const next = migrateSession(session, id, sourceId);
  const current = Number(next.dados?.pedidoNumero);
  if (Number.isInteger(current) && current > 0) {
    state.sessions[id] = next;
    return current;
  }

  const orderNumber = Number(state.nextOrderNumber);
  next.dados.pedidoNumero = orderNumber;
  state.nextOrderNumber = orderNumber + 1;
  next.updatedAt = nowIso();
  state.sessions[id] = next;
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);
  return orderNumber;
}

function resetSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  state.sessions[id] = createSession(id, clientId);
  writeJson(SESSIONS_PATH, state);
  return state.sessions[id];
}

function appendLead(payload = {}) {
  ensureParentDir(LEADS_PATH);
  const lead = {
    id: `lead_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: nowIso(),
    ...payload,
  };
  fs.appendFileSync(LEADS_PATH, JSON.stringify(lead) + '\n', 'utf8');
  return lead;
}

function listSessions() {
  return Object.values(state.sessions || {});
}

function resetSystem() {
  const previousSessionCount = Object.keys(state.sessions || {}).length;
  const previousNextOrderNumber = Number(state.nextOrderNumber || DEFAULT_ORDER_NUMBER);
  let previousLeadCount = 0;

  try {
    if (fs.existsSync(LEADS_PATH)) {
      const raw = fs.readFileSync(LEADS_PATH, 'utf8');
      previousLeadCount = raw.split('\n').filter((line) => line.trim()).length;
    }
  } catch (_) {}

  state.sessions = {};
  state.nextOrderNumber = DEFAULT_ORDER_NUMBER;
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);

  ensureParentDir(LEADS_PATH);
  fs.writeFileSync(LEADS_PATH, '', 'utf8');
  const previousIdentityCount = Identity.resetIdentities();

  return {
    resetAt: state.lastSavedAt,
    previousSessionCount,
    previousLeadCount,
    previousIdentityCount,
    previousNextOrderNumber,
    nextOrderNumber: state.nextOrderNumber,
  };
}

module.exports = {
  getSession,
  saveSession,
  ensureOrderNumber,
  resetSession,
  resetSystem,
  appendLead,
  listSessions,
  normalizeClientId,
  _test: {
    SESSIONS_PATH,
    LEADS_PATH,
    DEFAULT_ORDER_NUMBER,
  },
};
