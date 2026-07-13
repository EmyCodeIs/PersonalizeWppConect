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
    schemaVersion: 2,
    trackingStartedAt: null,
    updatedAt: null,
    catalog: {},
    contacts: {},
  };
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
    service: definition.service ? String(definition.service).trim() : null,
  };
}

function normalizeSeller(value, fallbackSource = 'migration') {
  if (!value) return null;
  const name = String(typeof value === 'string' ? value : value.name || '').trim();
  if (!name) return null;
  return {
    name,
    source: String(typeof value === 'object' ? value.source || fallbackSource : fallbackSource),
    updatedAt: typeof value === 'object' && value.updatedAt ? value.updatedAt : nowIso(),
  };
}

function normalizeAttention(value, hasSeller = false) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    needsAttention: source.needsAttention === undefined ? Boolean(hasSeller) : Boolean(source.needsAttention),
    lastMarkedUnreadAt: source.lastMarkedUnreadAt || null,
    lastClearedAt: source.lastClearedAt || null,
    lastUnreadError: source.lastUnreadError || null,
    lastUnreadSource: source.lastUnreadSource || null,
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
    attention: normalizeAttention(null, false),
    observedRequiredLabels: [],
    lastObservedAt: null,
    lastReconciledAt: null,
    lastReconcileResult: null,
    lastError: null,
  };
}

function migrateContact(record, key) {
  const next = record && typeof record === 'object' ? record : {};
  next.contactKey = next.contactKey || key;
  next.aliases = Array.isArray(next.aliases) ? next.aliases.filter(Boolean) : [];
  next.expected = next.expected && typeof next.expected === 'object'
    ? next.expected
    : { operational: null, seller: null };
  next.expected.operational = next.expected.operational || null;
  next.expected.seller = normalizeSeller(next.expected.seller);
  next.attention = normalizeAttention(next.attention, Boolean(next.expected.seller));
  next.observedRequiredLabels = Array.isArray(next.observedRequiredLabels)
    ? next.observedRequiredLabels
    : [];
  next.status = next.expected.operational ? 'tagged' : 'pending';
  return next;
}

function readState() {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const contacts = parsed?.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {};
    for (const [key, value] of Object.entries(contacts)) contacts[key] = migrateContact(value, key);
    return {
      schemaVersion: 2,
      trackingStartedAt: parsed?.trackingStartedAt || null,
      updatedAt: parsed?.updatedAt || null,
      catalog: parsed?.catalog && typeof parsed.catalog === 'object' ? parsed.catalog : {},
      contacts,
    };
  } catch (_) {
    return emptyState();
  }
}

const state = readState();

function saveState() {
  ensureParentDir();
  state.schemaVersion = 2;
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

function registerContact({ clientId, identity = null, source = 'event', profileName = null } = {}) {
  initializeTracking();
  const resolved = identity || Identity.resolveContact(clientId) || null;
  const contactKey = resolved?.contactKey || contactKeyFor(clientId);
  if (!contactKey) return null;

  const existing = migrateContact(
    state.contacts[contactKey] || buildContact(clientId, resolved),
    contactKey,
  );
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
  if (normalized.role === 'seller') {
    return setSellerResponsibility(clientId, normalized.name, { source });
  }
  if (normalized.role !== 'operational') return null;

  const record = registerContact({ clientId, source });
  if (!record) return null;
  const stored = state.contacts[record.contactKey];
  stored.expected.operational = {
    ...normalized,
    source,
    updatedAt: nowIso(),
  };
  stored.status = 'tagged';
  stored.lastError = null;
  saveState();
  return clone(stored);
}

function setSellerResponsibility(clientId, sellerName, { source = 'seller-assignment' } = {}) {
  const name = String(sellerName || '').trim();
  if (!name) return null;
  const record = registerContact({ clientId, source });
  if (!record) return null;
  const stored = state.contacts[record.contactKey];
  stored.expected.seller = {
    name,
    source,
    updatedAt: nowIso(),
  };
  stored.attention = normalizeAttention(stored.attention, true);
  stored.attention.needsAttention = true;
  stored.attention.lastClearedAt = null;
  stored.lastError = null;
  saveState();
  return clone(stored);
}

function clearSellerResponsibility(clientId, { source = 'seller-cleared' } = {}) {
  const key = state.contacts[clientId] ? clientId : contactKeyFor(clientId);
  const stored = state.contacts[key];
  if (!stored) return null;
  stored.expected.seller = null;
  stored.attention = normalizeAttention(stored.attention, false);
  stored.attention.needsAttention = false;
  stored.attention.lastClearedAt = nowIso();
  stored.lastSource = source;
  saveState();
  return clone(stored);
}

function clearAttention(clientId, { source = 'attention-cleared' } = {}) {
  const key = state.contacts[clientId] ? clientId : contactKeyFor(clientId);
  const stored = state.contacts[key];
  if (!stored) return null;
  stored.attention = normalizeAttention(stored.attention, Boolean(stored.expected?.seller));
  stored.attention.needsAttention = false;
  stored.attention.lastClearedAt = nowIso();
  stored.attention.lastUnreadSource = source;
  saveState();
  return clone(stored);
}

function markUnreadResult(clientId, {
  success,
  source = 'seller-attention',
  error = null,
} = {}) {
  const key = state.contacts[clientId] ? clientId : contactKeyFor(clientId);
  const stored = state.contacts[key];
  if (!stored) return null;
  stored.attention = normalizeAttention(stored.attention, Boolean(stored.expected?.seller));
  if (success) {
    stored.attention.lastMarkedUnreadAt = nowIso();
    stored.attention.lastUnreadError = null;
  } else if (error) {
    stored.attention.lastUnreadError = String(error);
  }
  stored.attention.lastUnreadSource = source;
  saveState();
  return clone(stored);
}

function captureObservedLabels(clientId, definitions = [], { source = 'whatsapp' } = {}) {
  const record = registerContact({ clientId, source });
  if (!record) return null;
  const stored = state.contacts[record.contactKey];
  const normalized = definitions
    .map(normalizeDefinition)
    .filter((item) => item?.role === 'operational');

  stored.observedRequiredLabels = normalized.map((item) => ({
    ...item,
    observedAt: nowIso(),
    source,
  }));
  stored.lastObservedAt = nowIso();

  if (normalized.length) {
    const currentKey = stored.expected?.operational?.key;
    const chosen = normalized.find((item) => item.key === currentKey) || normalized[0];
    stored.expected.operational = { ...chosen, source, updatedAt: nowIso() };
  }

  stored.status = stored.expected?.operational ? 'tagged' : 'pending';
  saveState();
  return clone(stored);
}

function saveCatalog(definition, item = {}) {
  const normalized = normalizeDefinition(definition);
  if (!normalized || normalized.role !== 'operational') return null;
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

function resetContacts({ preserveCatalog = true, keepContactKeys = [] } = {}) {
  const previousContactCount = Object.keys(state.contacts || {}).length;
  const keep = new Set((keepContactKeys || []).map(String).filter(Boolean));
  const nextContacts = {};
  for (const [key, record] of Object.entries(state.contacts || {})) {
    if (keep.has(key)) nextContacts[key] = record;
  }

  state.contacts = nextContacts;
  if (!preserveCatalog) state.catalog = {};
  state.trackingStartedAt = Object.keys(nextContacts).length ? state.trackingStartedAt : null;
  saveState();

  return {
    previousContactCount,
    removedContactCount: previousContactCount - Object.keys(nextContacts).length,
    remainingContactCount: Object.keys(nextContacts).length,
    catalogPreserved: preserveCatalog,
  };
}

function stats() {
  const contacts = Object.values(state.contacts || {});
  return {
    trackingStartedAt: state.trackingStartedAt,
    total: contacts.length,
    tagged: contacts.filter((item) => item.expected?.operational).length,
    pending: contacts.filter((item) => !item.expected?.operational).length,
    sellerAssigned: contacts.filter((item) => item.expected?.seller?.name).length,
    needsAttention: contacts.filter((item) => item.attention?.needsAttention).length,
  };
}

module.exports = {
  initializeTracking,
  registerContact,
  getContact,
  setExpectedLabel,
  setSellerResponsibility,
  clearSellerResponsibility,
  clearAttention,
  markUnreadResult,
  captureObservedLabels,
  saveCatalog,
  markReconciled,
  listContacts,
  resetContacts,
  stats,
  _test: {
    STORE_PATH,
    normalizeDefinition,
    normalizeSeller,
  },
};
