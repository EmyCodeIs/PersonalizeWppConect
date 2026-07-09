'use strict';

const fs = require('fs');
const path = require('path');

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
  return String(clientId || '').replace(/\D/g, '');
}

function createSession(id) {
  return {
    id,
    clientId: id,
    etapa: 'inicio',
    dados: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completed: false,
  };
}

function migrateSession(session, id) {
  const next = session && typeof session === 'object' ? session : createSession(id);
  next.id = next.id || id;
  next.clientId = next.clientId || id;
  next.etapa = next.etapa || next.step || 'inicio';
  next.dados = next.dados || next.data || {};
  next.createdAt = next.createdAt || nowIso();
  next.updatedAt = next.updatedAt || nowIso();
  return next;
}

function getSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  state.sessions[id] = migrateSession(state.sessions[id], id);
  return state.sessions[id];
}

function saveSession(session) {
  if (!session?.clientId && !session?.id) return null;
  const id = normalizeClientId(session.clientId || session.id);
  const next = migrateSession(session, id);
  next.updatedAt = nowIso();
  state.sessions[id] = next;
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);
  return next;
}

function resetSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  state.sessions[id] = createSession(id);
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

module.exports = {
  getSession,
  saveSession,
  resetSession,
  appendLead,
  listSessions,
  normalizeClientId,
};
