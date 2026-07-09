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

function getSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  if (!state.sessions[id]) {
    state.sessions[id] = {
      clientId: id,
      step: 'initial',
      data: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finished: false,
    };
  }
  return state.sessions[id];
}

function saveSession(session) {
  if (!session?.clientId) return null;
  session.updatedAt = nowIso();
  state.sessions[session.clientId] = session;
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);
  return session;
}

function resetSession(clientId) {
  const id = normalizeClientId(clientId);
  if (id) delete state.sessions[id];
  writeJson(SESSIONS_PATH, state);
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
