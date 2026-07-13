'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./contactIdentity');
const { env } = require('../config/env');

const DATA_DIR = path.join(process.cwd(), 'data');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const LEADS_PATH = path.join(DATA_DIR, 'leads.jsonl');
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');

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

const profileState = readJson(PROFILES_PATH, { profiles: {}, lastSavedAt: null });
if (!profileState.profiles || typeof profileState.profiles !== 'object') profileState.profiles = {};

function nowIso() {
  return new Date().toISOString();
}

function toFiniteTimestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function addHoursIso(baseIso, hours) {
  const baseTimestamp = toFiniteTimestamp(baseIso) || Date.now();
  const safeHours = Math.max(1, Number(hours || 0));
  return new Date(baseTimestamp + (safeHours * 60 * 60 * 1000)).toISOString();
}

function computeExpiresAt(lastInteractionAt, completed = false) {
  const ttlHours = completed
    ? env.completedSessionTtlHours
    : env.flowSessionTtlHours;
  return addHoursIso(lastInteractionAt || nowIso(), ttlHours);
}

function sanitizeProfileName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

function normalizeClientId(clientId) {
  return Identity.getSessionKey(clientId);
}

function createSession(id, chatId) {
  const identity = Identity.resolveContact(chatId || id);
  const createdAt = nowIso();
  return {
    id,
    clientId: id,
    chatId: identity?.primaryChatId || String(chatId || '').trim() || null,
    contactIdentity: identity || null,
    etapa: 'inicio',
    dados: {},
    createdAt,
    updatedAt: createdAt,
    lastInteractionAt: createdAt,
    expiresAt: computeExpiresAt(createdAt, false),
    completed: false,
    completedAt: null,
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
  next.updatedAt = next.updatedAt || next.lastInteractionAt || next.createdAt || nowIso();
  next.lastInteractionAt = next.lastInteractionAt || next.updatedAt || next.createdAt || nowIso();
  next.completed = Boolean(next.completed || next.dados?.botDone || next.etapa === 'concluido');
  next.completedAt = next.completed
    ? (next.completedAt || next.dados?.completedAt || next.updatedAt || next.lastInteractionAt)
    : null;
  next.expiresAt = next.expiresAt || computeExpiresAt(next.lastInteractionAt, next.completed);
  return next;
}

function createCustomerProfile(id, payload = {}) {
  const createdAt = nowIso();
  return {
    clientId: id,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    visitCount: 0,
    knownName: sanitizeProfileName(payload.name),
    createdAt,
    updatedAt: createdAt,
  };
}

function migrateCustomerProfile(profile, id) {
  const next = profile && typeof profile === 'object' ? profile : createCustomerProfile(id);
  next.clientId = id;
  next.firstSeenAt = next.firstSeenAt || next.createdAt || nowIso();
  next.lastSeenAt = next.lastSeenAt || next.updatedAt || next.firstSeenAt || nowIso();
  next.visitCount = Math.max(0, Number(next.visitCount || 0));
  next.knownName = sanitizeProfileName(next.knownName || next.name);
  next.createdAt = next.createdAt || next.firstSeenAt;
  next.updatedAt = next.updatedAt || next.lastSeenAt;
  return next;
}

function isSessionExpired(session, currentTime = Date.now()) {
  const expiresAt = toFiniteTimestamp(session?.expiresAt);
  if (!expiresAt) return false;
  return expiresAt <= currentTime;
}

function persistState() {
  state.lastSavedAt = nowIso();
  writeJson(SESSIONS_PATH, state);
}

function persistProfiles() {
  profileState.lastSavedAt = nowIso();
  writeJson(PROFILES_PATH, profileState);
}

function purgeExpiredSessions({ write = true } = {}) {
  const currentTime = Date.now();
  let changed = false;

  for (const [id, session] of Object.entries(state.sessions || {})) {
    const migrated = migrateSession(session, id, session?.chatId || session?.clientId || id);
    if (isSessionExpired(migrated, currentTime)) {
      delete state.sessions[id];
      changed = true;
      continue;
    }

    if (state.sessions[id] !== migrated) {
      state.sessions[id] = migrated;
      changed = true;
    }
  }

  if (changed && write) persistState();
  return changed;
}

function getSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;

  const previous = state.sessions[id];
  const migrated = migrateSession(previous, id, clientId);
  if (previous && isSessionExpired(migrated)) {
    state.sessions[id] = createSession(id, clientId);
    persistState();
    return state.sessions[id];
  }

  state.sessions[id] = migrated;
  return state.sessions[id];
}

function saveSession(session) {
  if (!session?.clientId && !session?.id && !session?.chatId) return null;
  const sourceId = session.chatId || session.clientId || session.id;
  const id = normalizeClientId(sourceId);
  const next = migrateSession(session, id, sourceId);
  const updatedAt = nowIso();
  next.updatedAt = updatedAt;
  next.lastInteractionAt = updatedAt;
  next.completed = Boolean(next.completed || next.dados?.botDone || next.etapa === 'concluido');
  next.completedAt = next.completed
    ? (next.completedAt || next.dados?.completedAt || updatedAt)
    : null;
  next.expiresAt = computeExpiresAt(updatedAt, next.completed);
  state.sessions[id] = next;
  persistState();
  return next;
}

function resetSession(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  state.sessions[id] = createSession(id, clientId);
  persistState();
  return state.sessions[id];
}

function getCustomerProfile(clientId) {
  const id = normalizeClientId(clientId);
  if (!id) return null;
  const existing = profileState.profiles[id];
  if (!existing) return null;
  const migrated = migrateCustomerProfile(existing, id);
  profileState.profiles[id] = migrated;
  return migrated;
}

function rememberCustomerProfile(clientId, payload = {}) {
  const id = normalizeClientId(clientId);
  if (!id) return null;

  const existing = profileState.profiles[id];
  const next = migrateCustomerProfile(existing, id);
  const timestamp = payload.seenAt || nowIso();
  next.lastSeenAt = timestamp;
  next.updatedAt = timestamp;
  if (!next.firstSeenAt) next.firstSeenAt = timestamp;
  const nextName = sanitizeProfileName(payload.name);
  if (nextName) next.knownName = nextName;
  if (!existing && next.visitCount < 1) next.visitCount = 1;
  profileState.profiles[id] = next;
  persistProfiles();
  return next;
}

function beginCustomerConversation(clientId, payload = {}) {
  const id = normalizeClientId(clientId);
  if (!id) return { profile: null, isReturning: false };

  const existing = getCustomerProfile(id);
  const next = migrateCustomerProfile(existing, id);
  const timestamp = payload.seenAt || nowIso();
  next.lastSeenAt = timestamp;
  next.updatedAt = timestamp;
  next.visitCount = Math.max(0, Number(next.visitCount || 0)) + 1;
  const nextName = sanitizeProfileName(payload.name);
  if (nextName) next.knownName = nextName;
  profileState.profiles[id] = next;
  persistProfiles();

  return {
    profile: next,
    isReturning: Boolean(existing && Number(existing.visitCount || 0) >= 1),
  };
}

function listCustomerProfiles() {
  return Object.entries(profileState.profiles || {}).map(([id, profile]) => (
    migrateCustomerProfile(profile, id)
  ));
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
  purgeExpiredSessions();
  return Object.entries(state.sessions || {}).map(([id, session]) => (
    migrateSession(session, id, session?.chatId || session?.clientId || id)
  ));
}

function resetSystem() {
  const previousSessionCount = Object.keys(state.sessions || {}).length;
  const previousProfileCount = Object.keys(profileState.profiles || {}).length;
  let previousLeadCount = 0;

  try {
    if (fs.existsSync(LEADS_PATH)) {
      const raw = fs.readFileSync(LEADS_PATH, 'utf8');
      previousLeadCount = raw.split('\n').filter((line) => line.trim()).length;
    }
  } catch (_) {}

  state.sessions = {};
  persistState();

  profileState.profiles = {};
  persistProfiles();

  ensureDataDir();
  fs.writeFileSync(LEADS_PATH, '', 'utf8');
  const previousIdentityCount = Identity.resetIdentities();

  return {
    resetAt: state.lastSavedAt,
    previousSessionCount,
    previousProfileCount,
    previousLeadCount,
    previousIdentityCount,
  };
}

purgeExpiredSessions({ write: false });

module.exports = {
  getSession,
  saveSession,
  resetSession,
  resetSystem,
  appendLead,
  listSessions,
  normalizeClientId,
  isSessionExpired,
  purgeExpiredSessions,
  getCustomerProfile,
  rememberCustomerProfile,
  beginCustomerConversation,
  listCustomerProfiles,
};
