'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./contactIdentity');

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const LEADS_PATH = path.join(DATA_DIR, 'leads.jsonl');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
  ensureDataDir();
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(`${filePath}.tmp`, filePath);
}

const state = readJson(SESSIONS_PATH, { sessions: {}, lastSavedAt: null });
if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};

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

function resetSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  state.sessions[id] = createSession(id, clientId);
  writeJson(SESSIONS_PATH, state);
  return state.sessions[id];
}

function appendLead(payload = {}) {
  ensureDataDir();
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
  let previousLeadCount = 0;

  try {
    if (fs.existsSync(LEADS_PATH)) {
      const raw = fs.readFileSync(LEADS_PATH, 'utf8');
      previousLeadCount = raw.split('\n').filter((line) => line.trim()).length;
    }
  } catch (_) {}

  state.sessions = {};
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);

  ensureDataDir();
  fs.writeFileSync(LEADS_PATH, '', 'utf8');
  const previousIdentityCount = Identity.resetIdentities();

  return {
    resetAt: state.lastSavedAt,
    previousSessionCount,
    previousLeadCount,
    previousIdentityCount,
  };
}

module.exports = {
  getSession,
  saveSession,
  resetSession,
  resetSystem,
  appendLead,
  listSessions,
  normalizeClientId,
};
