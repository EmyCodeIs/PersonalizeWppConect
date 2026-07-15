'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./contactIdentity');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'bot-activity.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { contacts: {}, lastSavedAt: null };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      contacts: parsed?.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {},
      lastSavedAt: parsed?.lastSavedAt || null,
    };
  } catch (_) {
    return { contacts: {}, lastSavedAt: null };
  }
}

const state = readState();

function normalizeChatId(value) {
  try {
    return Identity.normalizeChatId(value);
  } catch (_) {
    return String(value || '').trim().toLowerCase();
  }
}

function candidateKeys(clientId) {
  const values = [];
  try { values.push(Identity.getSessionKey(clientId)); } catch (_) {}
  values.push(normalizeChatId(clientId));
  try {
    if (typeof Identity.getLabelCandidateIds === 'function') {
      values.push(...Identity.getLabelCandidateIds(clientId));
    }
  } catch (_) {}
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function persist() {
  ensureDataDir();
  state.lastSavedAt = new Date().toISOString();
  const serialized = JSON.stringify(state, null, 2);
  const tempPath = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, serialized, 'utf8');
  try {
    fs.renameSync(tempPath, STORE_PATH);
  } catch (_) {
    fs.writeFileSync(STORE_PATH, serialized, 'utf8');
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

function markBotOutbound(clientId, payload = {}) {
  const keys = candidateKeys(clientId);
  if (!keys.length) return null;

  const record = {
    chatId: normalizeChatId(clientId) || null,
    at: payload.at || new Date().toISOString(),
    messageId: String(payload.messageId || '').trim() || null,
    type: String(payload.type || 'text').trim().toLowerCase() || 'text',
  };

  for (const key of keys) state.contacts[key] = record;
  persist();
  return record;
}

function getLastBotOutbound(clientId) {
  for (const key of candidateKeys(clientId)) {
    const record = state.contacts[key];
    if (record?.at) return { ...record };
  }
  return null;
}

function resetAll() {
  state.contacts = {};
  persist();
}

module.exports = {
  markBotOutbound,
  getLastBotOutbound,
  resetAll,
  _test: {
    candidateKeys,
    normalizeChatId,
  },
};
