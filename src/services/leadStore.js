'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const LEADS_PATH = path.join(DATA_DIR, 'leads.jsonl');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let sessions = readJson(SESSIONS_PATH, {});

function normalizeClientId(id) {
  return String(id || '').replace(/\D/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function getSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  if (!sessions[id]) {
    sessions[id] = {
      id,
      etapa: 'inicio',
      dados: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completed: false,
    };
    saveSessions();
  }
  return sessions[id];
}

function saveSession(session) {
  if (!session?.id) return null;
  session.updatedAt = nowIso();
  sessions[session.id] = session;
  saveSessions();
  return session;
}

function resetSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  sessions[id] = {
    id,
    etapa: 'inicio',
    dados: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completed: false,
  };
  saveSessions();
  return sessions[id];
}

function saveSessions() {
  writeJson(SESSIONS_PATH, sessions);
}

function appendLead(lead) {
  ensureDir();
  const payload = {
    ...lead,
    savedAt: nowIso(),
  };
  fs.appendFileSync(LEADS_PATH, JSON.stringify(payload) + '\n', 'utf8');
  return payload;
}

function listSessions() {
  return Object.values(sessions);
}

module.exports = {
  getSession,
  saveSession,
  resetSession,
  appendLead,
  listSessions,
  normalizeClientId,
};
