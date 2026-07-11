'use strict';

const fs = require('fs');
const path = require('path');
const Identity = require('./contactIdentity');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = process.env.CONTACT_LABEL_STORE_PATH
  ? path.resolve(process.cwd(), process.env.CONTACT_LABEL_STORE_PATH)
  : path.join(DATA_DIR, 'contact-labels.json');

function nowIso() {
  return new Date().toISOString();
}

function ensureParentDir() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

function emptyState() {
  return {
    schemaVersion: 1,
    trackingStartedAt: null,
    updatedAt: null,
    catalog: {},
    contacts: {},
  };
}

function readState() {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      schemaVersion: 1,
      trackingStartedAt: parsed?.trackingStartedAt || null,
      updatedAt: parsed?.updatedAt || null,
      catalog: parsed?.catalog && typeof parsed.catalog === 'object' ? parsed.catalog : {},
      contacts: parsed?.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {},
    };
  } catch (_) {
    return emptyState();
  }
}

const state = readState();

function saveState() {
  ensureParentDir();
  state.updatedAt = nowIso();
  const tempPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, STORE_PATH);
}

function initializeTracking() {
  if (!state.trackingStartedAt) {
    state.trackingStartedAt = nowIso();
    saveState();
  }
  return state.trackingStartedAt;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeDefinition(definition = {}) {
  const name = String(definition.name || '').trim();
  const key = String(definition.key || '').trim();
  const kind = String(definition.kind || '').trim();
  const role = String(definition.role || '').trim();
  if (!key || !name || !kind || !role) return null;
  return {
    key,
    name,
    color: String(definition.color || '').trim() || 'gray',
    kind,
    role,
  };
}

function contactKeyFor(value) {
  return Identity.getSessionKey(value);
}

function buildContact(clientId, identity = null) {
  const resolved = identity || Identity.resolveContact(clientId) || {};
  const contactKey = resolved.contactKey || contactKeyFor(clientId);
  return {
    contactKey,
    primaryChatId: resolved.primaryChatId || String(clientId || '').trim() || null,
    aliases: [...new Set([
      resolved.primaryChatId,
      resolved.lid,
      resolved.cUsId,
      ...(resolved.aliases || []),
    ].filter(Boolean))],
    phone: resolved.phone || null,
    name: null,
    firstSeenAt: nowIso(),
    lastSeenAt: nowIso(),
    lastSource: null,
    status: 'pending',
    expected: {
      operational: null,
      seller: null,
    },
    observedRequiredLabels: [],
    lastObservedAt: null,
    lastReconciledAt: null,
    lastReconcileResult: null,
    lastError: null,
  };
}

function registerContact({ clientId, identity = null, source = 'event', profileName = null } = {}) {
  initializeTracking();
  const resolved = identity || Identity.resolveContact(clientId) || null;
  const contactKey = resolved?.contactKey || contactKeyFor(clientId);
  if (!contactKey) return null;

  const existing = state.contacts[contactKey] || buildContact(clientId, resolved);
  const aliases = [...new Set([
    ...(existing.aliases || []),
    resolved?.primaryChatId,
    resolved?.lid,
    resolved?.cUsId,
    ...(resolved?.aliases || []),
    String(clientId || '').trim(),
  ].filter(Boolean))];

  existing.contactKey = contactKey;
  existing.primaryChatId = resolved?.primaryChatId || existing.primaryChatId || aliases[0] || null;
  existing.aliases = aliases;
  existing.phone = resolved?.phone || existing.phone || null;
  existing.name = String(profileName || existing.name || '').trim() || null;
  existing.firstSeenAt = existing.firstSeenAt || nowIso();
  existing.lastSeenAt = nowIso();
  existing.lastSource = source;
  existing.expected = existing.expected || { operational: null, seller: null };
  existing.status = existing.expected.operational ? 'tagged' : 'pending';

  state.contacts[contactKey] = existing;
  saveState();
  return clone(existing);
}

function getContact(value) {
  const key = state.contacts[value] ? value : contactKeyFor(value);
  return clone(state.contacts[key] || null);
}

function setExpectedLabel(clientId, definition, { source = 'flow' } = {}) {
  const normalized = normalizeDefinition(definition);
  if (!normalized) return null;
  const record = registerContact({ clientId, source });
  if (!record) return null;
  const stored = state.contacts[record.contactKey];
  const entry = {
    ...normalized,
    source,
    updatedAt: nowIso(),
  };

  if (normalized.role === 'operational') stored.expected.operational = entry;
  if (normalized.role === 'seller') stored.expected.seller = entry;
  stored.status = stored.expected.operational ? 'tagged' : 'pending';
  stored.lastError = null;
  saveState();
  return clone(stored);
}

function captureObservedLabels(clientId, definitions = [], { source = 'whatsapp' } = {}) {
  const record = registerContact({ clientId, source });
  if (!record) return null;
  const stored = state.contacts[record.contactKey];
  const normalized = definitions.map(normalizeDefinition).filter(Boolean);

  stored.observedRequiredLabels = normalized.map((item) => ({
    ...item,
    observedAt: nowIso(),
    source,
  }));
  stored.lastObservedAt = nowIso();

  const operational = normalized.filter((item) => item.role === 'operational');
  const sellers = normalized.filter((item) => item.role === 'seller');

  // O que ainda veio do WhatsApp/mobile prevalece. Quando o Web perde o vínculo
  // e a leitura retorna vazia, o esperado salvo não é apagado.
  if (operational.length) {
    const currentKey = stored.expected?.operational?.key;
    const chosen = operational.find((item) => item.key === currentKey) || operational[0];
    stored.expected.operational = { ...chosen, source, updatedAt: nowIso() };
  }
  if (sellers.length) {
    const currentKey = stored.expected?.seller?.key;
    const chosen = sellers.find((item) => item.key === currentKey) || sellers[0];
    stored.expected.seller = { ...chosen, source, updatedAt: nowIso() };
  }

  stored.status = stored.expected?.operational ? 'tagged' : 'pending';
  saveState();
  return clone(stored);
}

function saveCatalog(definition, item = {}) {
  const normalized = normalizeDefinition(definition);
  if (!normalized) return null;
  state.catalog[normalized.key] = {
    ...normalized,
    id: String(item.id || item.labelId || '').trim() || null,
    colorIndex: Number.isFinite(Number(item.colorIndex)) ? Number(item.colorIndex) : null,
    count: Number.isFinite(Number(item.count)) ? Number(item.count) : null,
    lastSeenAt: nowIso(),
  };
  saveState();
  return clone(state.catalog[normalized.key]);
}

function markReconciled(clientId, result = {}) {
  const key = state.contacts[clientId] ? clientId : contactKeyFor(clientId);
  const record = state.contacts[key];
  if (!record) return null;
  record.lastReconciledAt = nowIso();
  record.lastReconcileResult = clone(result);
  record.lastError = result?.error ? String(result.error) : null;
  record.status = record.expected?.operational ? 'tagged' : 'pending';
  saveState();
  return clone(record);
}

function listContacts() {
  return Object.values(state.contacts || {}).map(clone);
}

function stats() {
  const contacts = Object.values(state.contacts || {});
  return {
    trackingStartedAt: state.trackingStartedAt,
    total: contacts.length,
    tagged: contacts.filter((item) => item.expected?.operational).length,
    pending: contacts.filter((item) => !item.expected?.operational).length,
  };
}

module.exports = {
  initializeTracking,
  registerContact,
  getContact,
  setExpectedLabel,
  captureObservedLabels,
  saveCatalog,
  markReconciled,
  listContacts,
  stats,
  _test: {
    STORE_PATH,
    normalizeDefinition,
  },
};
