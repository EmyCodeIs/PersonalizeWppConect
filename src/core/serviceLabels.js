'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');
const Sessions = require('../services/leadStore');
const LabelStore = require('../services/contactLabelStore');

const creationLocks = new Map();
const observationLocks = new Map();
const sellerAttentionMarkedThisRuntime = new Set();

const COLOR_HEX = Object.freeze({
  green: '#00a884',
  red: '#ea0038',
  gray: '#667781',
  grey: '#667781',
  blue: '#027eb5',
  yellow: '#f7b928',
  orange: '#ff7a00',
  purple: '#7f66ff',
  pink: '#ff7eb6',
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(value) {
  return normalizeName(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function desiredHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return COLOR_HEX[normalizeName(raw)] || COLOR_HEX.gray;
}

function listId(item) {
  return String(item?.id?._serialized || item?.id || item?.labelId || '').trim();
}

function listName(item) {
  return String(item?.name || item?.label || '').trim();
}

function listCount(item) {
  const value = Number(item?.count);
  return Number.isFinite(value) ? value : 0;
}

function compareListIds(a, b) {
  const aId = listId(a);
  const bId = listId(b);
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function normalizeDefinition(definition = {}) {
  const name = String(definition.name || '').trim();
  if (!name) return null;
  return {
    key: String(definition.key || `custom:${slug(name)}`).trim(),
    name,
    color: String(definition.color || 'gray').trim(),
    kind: String(definition.kind || 'service').trim(),
    role: 'operational',
    service: definition.service ? String(definition.service).trim() : null,
  };
}

function getServiceLabel(service) {
  if (service === 'letreiro') {
    return normalizeDefinition({
      key: 'service:letreiro',
      kind: 'service',
      service: 'letreiro',
      name: env.serviceLabelLetreiro,
      color: env.serviceLabelLetreiroColor,
    });
  }
  if (service === 'plotagem') {
    return normalizeDefinition({
      key: 'service:plotagem',
      kind: 'service',
      service: 'plotagem',
      name: env.serviceLabelPlotagem,
      color: env.serviceLabelPlotagemColor,
    });
  }
  return normalizeDefinition({
    key: 'service:outros',
    kind: 'service',
    service: 'outros',
    name: env.serviceLabelOutros,
    color: env.serviceLabelOutrosColor,
  });
}

function getSupportLabel() {
  return normalizeDefinition({
    key: 'support',
    kind: 'support',
    name: env.supportLabelName,
    color: env.supportLabelColor,
  });
}

function requiredLabelDefinitions() {
  return [
    getServiceLabel('letreiro'),
    getServiceLabel('plotagem'),
    getServiceLabel('outros'),
    getSupportLabel(),
  ].filter(Boolean);
}

function definitionByName(name) {
  const wanted = normalizeName(name);
  return requiredLabelDefinitions().find((item) => normalizeName(item.name) === wanted) || null;
}

function definitionByKey(key) {
  return requiredLabelDefinitions().find((item) => item.key === key) || null;
}

function orderedCandidateIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  const known = Identity.getLabelCandidateIds(clientId);
  return [...new Set([direct, ...known].filter(Boolean))];
}

function canonicalSellerName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const configured = Array.isArray(env.sellerNames) ? env.sellerNames : [];
  if (!configured.length) return raw;
  return configured.find((item) => normalizeName(item) === normalizeName(raw)) || null;
}

async function readBusinessLists(client) {
  if (!client?.page?.evaluate) return [];
  try {
    return await client.page.evaluate(async () => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels) return [];
      const value = await WPP.labels.getAllLabels();
      const list = Array.isArray(value) ? value : Object.values(value || {});
      return list.map((item) => ({
        id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
        name: String(item?.name || item?.label || ''),
        colorIndex: item?.colorIndex ?? item?.colorId ?? item?.color ?? null,
        count: Number(item?.count || 0),
      })).filter((item) => item.id && item.name);
    });
  } catch (err) {
    console.warn('[ETIQUETAS] não foi possível ler o catálogo:', err?.message || err);
    return [];
  }
}

async function readPalette(client) {
  if (!client?.page?.evaluate) return [];
  try {
    return await client.page.evaluate(async () => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getLabelColorPalette) return [];
      const value = await WPP.labels.getLabelColorPalette();
      return Array.isArray(value) ? value : Object.values(value || {});
    });
  } catch (_) {
    return [];
  }
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function nearestPaletteIndex(palette, requestedHex) {
  const wanted = hexToRgb(requestedHex);
  if (!wanted || !Array.isArray(palette) || !palette.length) return null;
  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((entry, index) => {
    const candidateHex = typeof entry === 'string'
      ? entry
      : entry?.hex || entry?.hexColor || entry?.color || entry?.value;
    const candidate = hexToRgb(candidateHex);
    if (!candidate) return;
    const distance = ((candidate[0] - wanted[0]) ** 2)
      + ((candidate[1] - wanted[1]) ** 2)
      + ((candidate[2] - wanted[2]) ** 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return Number.isInteger(bestIndex) ? bestIndex : null;
}

function expectedColorIndex(definition, palette = []) {
  const requestedHex = definition?.key === 'service:letreiro'
    ? env.serviceLabelLetreiroColorHex
    : desiredHex(definition?.color);
  const fromPalette = nearestPaletteIndex(palette, requestedHex);
  if (Number.isInteger(fromPalette)) return fromPalette;
  if (definition?.key === 'service:letreiro') {
    const configured = Number(env.serviceLabelLetreiroColorIndex);
    return Number.isInteger(configured) && configured >= 0 ? configured : 5;
  }
  return null;
}

function matchingLists(catalog, definition) {
  const wanted = normalizeName(definition?.name);
  return (catalog || [])
    .filter((item) => normalizeName(listName(item)) === wanted)
    .filter((item) => listId(item));
}

function pickPreferredList(items = []) {
  return [...items].sort((a, b) => {
    const countDifference = listCount(b) - listCount(a);
    if (countDifference) return countDifference;
    return compareListIds(a, b);
  })[0] || null;
}

function resolveCanonicalList(catalog, definition, palette = []) {
  const matches = matchingLists(catalog, definition);
  const expectedIndex = expectedColorIndex(definition, palette);
  const correctColor = Number.isInteger(expectedIndex)
    ? matches.filter((item) => Number(item.colorIndex) === expectedIndex)
    : [];

  let item = null;
  if (correctColor.length) item = pickPreferredList(correctColor);
  else if (!Number.isInteger(expectedIndex) && matches.length) item = pickPreferredList(matches);

  return {
    item,
    expectedIndex,
    matches,
    duplicates: item ? matches.filter((candidate) => listId(candidate) !== listId(item)) : matches,
  };
}

function findByDefinition(catalog, definition, palette = []) {
  return resolveCanonicalList(catalog, definition, palette).item;
}

async function createCanonicalList(client, definition, palette) {
  if (!client?.page?.evaluate) return null;
  const key = definition.key;
  if (creationLocks.has(key)) return creationLocks.get(key);

  const task = (async () => {
    const beforeCatalog = await readBusinessLists(client);
    const before = resolveCanonicalList(beforeCatalog, definition, palette);
    if (before.item) return before.item;

    const requestedIndex = expectedColorIndex(definition, palette);
    let createdId = '';
    try {
      createdId = await client.page.evaluate(async ({ name, colorIndex }) => {
        const WPP = window.WPP || null;
        if (!WPP?.lists?.create) throw new Error('WPP.lists.create indisponível');
        return String(await WPP.lists.create(
          name,
          [],
          Number.isInteger(colorIndex) ? colorIndex : undefined,
        ) || '');
      }, { name: definition.name, colorIndex: requestedIndex });
    } catch (err) {
      console.warn(`[ETIQUETAS] falha ao criar "${definition.name}":`, err?.message || err);
      return null;
    }

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await wait(500);
      const catalog = await readBusinessLists(client);
      const byCreatedId = catalog.find((item) => listId(item) === String(createdId)) || null;
      const resolved = resolveCanonicalList(catalog, definition, palette);
      let visible = resolved.item;
      if (
        !visible
        && byCreatedId
        && (
          !Number.isInteger(requestedIndex)
          || Number(byCreatedId.colorIndex) === requestedIndex
        )
      ) {
        visible = byCreatedId;
      }
      if (visible) return visible;
    }

    console.warn(
      `[ETIQUETAS] "${definition.name}" foi criada, mas a versão com a cor esperada não apareceu no catálogo.`,
    );
    return null;
  })().finally(() => creationLocks.delete(key));

  creationLocks.set(key, task);
  return task;
}

async function ensureRequiredCatalog(channel, { definitions = requiredLabelDefinitions() } = {}) {
  if (!env.enableContactLabels || !channel?.client) {
    return {
      ready: false,
      catalog: {},
      missing: definitions.map((item) => item.key),
      colorMismatches: [],
      duplicates: [],
    };
  }

  const client = channel.client;
  const palette = await readPalette(client);
  const catalogByKey = {};
  const missing = [];
  const colorMismatches = [];
  const duplicateReport = [];

  for (const rawDefinition of definitions) {
    const definition = normalizeDefinition(rawDefinition);
    if (!definition) continue;

    let catalog = await readBusinessLists(client);
    let resolved = resolveCanonicalList(catalog, definition, palette);

    if (!resolved.item) {
      const shouldCreate = resolved.matches.length === 0 || env.recreateMismatchedOperationalLabels;
      if (shouldCreate) {
        await createCanonicalList(client, definition, palette);
        catalog = await readBusinessLists(client);
        resolved = resolveCanonicalList(catalog, definition, palette);
      }
    }

    if (!resolved.item) {
      missing.push(definition.key);
      if (resolved.matches.length) {
        colorMismatches.push({
          key: definition.key,
          name: definition.name,
          expectedIndex: resolved.expectedIndex,
          found: resolved.matches.map((item) => ({
            id: listId(item),
            colorIndex: Number(item.colorIndex),
          })),
        });
      }
      continue;
    }

    const duplicateIds = resolved.duplicates.map(listId).filter(Boolean);
    const entry = {
      ...resolved.item,
      definition,
      expectedColorIndex: resolved.expectedIndex,
      duplicateIds,
      duplicates: resolved.duplicates,
    };
    catalogByKey[definition.key] = entry;
    LabelStore.saveCatalog(definition, resolved.item);

    if (duplicateIds.length) {
      duplicateReport.push({
        key: definition.key,
        name: definition.name,
        canonicalId: listId(resolved.item),
        canonicalColorIndex: Number(resolved.item.colorIndex),
        duplicateIds,
      });
      console.warn(
        `[ETIQUETAS] duplicata detectada em "${definition.name}": `
        + `canônica=${listId(resolved.item)} cor=${String(resolved.item.colorIndex)} `
        + `duplicadas=${duplicateIds.join(',')}`,
      );
    } else {
      console.log(
        `[ETIQUETAS] canônica: "${definition.name}" | ID ${listId(resolved.item)} `
        + `| cor=${String(resolved.item.colorIndex)}`,
      );
    }
  }

  return {
    ready: missing.length === 0,
    catalog: catalogByKey,
    missing,
    colorMismatches,
    duplicates: duplicateReport,
    palette,
  };
}

async function inspectCandidate(client, chatId) {
  if (!client?.page?.evaluate || !chatId) return { chatFound: false, items: [] };
  try {
    return await client.page.evaluate(async ({ chatId: targetChatId }) => {
      const WPP = window.WPP || null;
      const StoreWindow = window.Store || null;
      let chat = StoreWindow?.Chat?.get?.(targetChatId) || null;
      if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
        try { chat = await StoreWindow.Chat.find(targetChatId); } catch (_) {}
      }
      if (!chat) return { chatFound: false, items: [] };

      let catalog = [];
      try {
        if (WPP?.labels?.getAllLabels) {
          const value = await WPP.labels.getAllLabels();
          catalog = Array.isArray(value) ? value : Object.values(value || {});
        }
      } catch (_) {}

      const labelStore = StoreWindow?.Label || StoreWindow?.Labels || null;
      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { chatFound: true, items: [], available: false };
      }
      const value = labelStore.getLabelsForModel(chat) || [];
      const attached = Array.isArray(value) ? value : Object.values(value || {});
      const items = attached.map((entry) => {
        const id = String(entry?.id?._serialized || entry?.id || entry?.labelId || entry || '');
        const known = catalog.find((item) => String(
          item?.id?._serialized || item?.id || item?.labelId || '',
        ) === id) || null;
        return {
          id,
          name: String(entry?.name || entry?.label || known?.name || known?.label || ''),
          colorIndex: entry?.colorIndex ?? entry?.colorId ?? entry?.color
            ?? known?.colorIndex ?? known?.colorId ?? known?.color ?? null,
        };
      }).filter((item) => item.id);
      return { chatFound: true, available: true, items };
    }, { chatId });
  } catch (err) {
    return { chatFound: false, available: false, items: [], error: String(err?.message || err) };
  }
}

async function inspectContactLabels(client, clientId) {
  for (const chatId of orderedCandidateIds(clientId)) {
    const result = await inspectCandidate(client, chatId);
    if (result.chatFound) return { ...result, chatId };
  }
  return { chatFound: false, available: false, items: [], chatId: null };
}

function persistManualLabels(clientId, items = []) {
  if (!env.storeManualContactLabels) return;
  try {
    const requiredNames = new Set(requiredLabelDefinitions().map((item) => normalizeName(item.name)));
    const manual = items
      .filter((item) => item?.name && !requiredNames.has(normalizeName(item.name)))
      .map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || '').trim(),
        colorIndex: Number.isFinite(Number(item.colorIndex)) ? Number(item.colorIndex) : null,
      }));
    if (!manual.length) return;
    const session = Sessions.getSession(clientId);
    session.dados = session.dados || {};
    session.dados.manualContactLabels = manual;
    session.dados.manualContactLabelNames = manual.map((item) => item.name);
    session.dados.manualContactLabelsDetectedAt = new Date().toISOString();
    Sessions.saveSession(session);
  } catch (_) {}
}

async function observeContactLabels(channel, clientId, { force = false, source = 'whatsapp' } = {}) {
  if (!channel?.client) return null;
  const record = LabelStore.getContact(clientId);
  if (!record) return null;
  if (!force && record.lastObservedAt) {
    const age = Date.now() - new Date(record.lastObservedAt).getTime();
    if (Number.isFinite(age) && age < env.labelObservationMinIntervalMs) return record;
  }

  const lockKey = record.contactKey;
  if (observationLocks.has(lockKey)) return observationLocks.get(lockKey);
  const task = (async () => {
    const inspected = await inspectContactLabels(channel.client, clientId);
    if (!inspected.chatFound) return record;
    const definitions = inspected.items
      .map((item) => definitionByName(item.name))
      .filter(Boolean);
    persistManualLabels(clientId, inspected.items);
    return LabelStore.captureObservedLabels(clientId, definitions, { source });
  })().finally(() => observationLocks.delete(lockKey));
  observationLocks.set(lockKey, task);
  return task;
}

async function addTargetLabel(client, chatId, targetId) {
  return client.page.evaluate(async ({ chatId: targetChatId, targetId: id }) => {
    const WPP = window.WPP || null;
    if (!WPP?.lists?.addChats) throw new Error('WPP.lists.addChats indisponível');
    await WPP.lists.addChats(String(id), [targetChatId]);
    return true;
  }, { chatId, targetId });
}

async function removeLabelsFromChat(client, chatId, removeIds) {
  const ids = [...new Set((removeIds || []).map(String).filter(Boolean))];
  if (!ids.length) return true;
  return client.page.evaluate(async ({ chatId: targetChatId, removeIds: targetIds }) => {
    const WPP = window.WPP || null;
    if (!WPP?.lists?.removeChats) throw new Error('WPP.lists.removeChats indisponível');
    for (const id of targetIds) {
      await WPP.lists.removeChats(String(id), [targetChatId]);
    }
    return true;
  }, { chatId, removeIds: ids });
}

async function verifyTargetAndRemoved(client, chatId, targetId, removeIds = []) {
  const removedSet = new Set((removeIds || []).map(String));
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (attempt > 1) await wait(450);
    const after = await inspectCandidate(client, chatId);
    if (!after.chatFound || after.available === false) {
      return { verified: null, items: after.items || [] };
    }
    const ids = new Set(after.items.map((item) => String(item.id)));
    const hasTarget = ids.has(String(targetId));
    const removedGone = [...removedSet].every((id) => !ids.has(id));
    if (hasTarget && removedGone) return { verified: true, items: after.items };
  }
  const finalState = await inspectCandidate(client, chatId);
  return { verified: false, items: finalState.items || [] };
}

async function applyDefinitionWithCatalog(channel, clientId, definition, catalogByKey) {
  const normalized = normalizeDefinition(definition);
  if (!normalized || !channel?.client) return { applied: false, reason: 'invalid_definition' };
  const target = catalogByKey?.[normalized.key];
  if (!target) return { applied: false, reason: 'target_missing' };

  const targetId = listId(target);
  const duplicateIds = new Set((target.duplicateIds || []).map(String).filter(Boolean));
  const otherOperationalIds = requiredLabelDefinitions()
    .filter((item) => item.key !== normalized.key)
    .map((item) => catalogByKey?.[item.key])
    .map(listId)
    .filter(Boolean);

  for (const chatId of orderedCandidateIds(clientId)) {
    const before = await inspectCandidate(channel.client, chatId);
    if (!before.chatFound) continue;

    const attachedIds = new Set(before.items.map((item) => String(item.id)));
    try {
      if (!attachedIds.has(targetId)) {
        await addTargetLabel(channel.client, chatId, targetId);
      }
    } catch (err) {
      console.warn(`[ETIQUETAS] falha ao aplicar a canônica ${targetId} em ${chatId}:`, err?.message || err);
      continue;
    }

    const targetVerification = await verifyTargetAndRemoved(channel.client, chatId, targetId, []);
    if (targetVerification.verified !== true) {
      return {
        applied: true,
        verified: targetVerification.verified,
        migrated: false,
        chatId,
        targetId,
        targetName: normalized.name,
        key: normalized.key,
        reason: targetVerification.verified === false ? 'target_not_confirmed' : null,
      };
    }

    const removable = [...new Set([
      ...[...duplicateIds].filter((id) => attachedIds.has(id)),
      ...otherOperationalIds.filter((id) => attachedIds.has(id)),
    ])].filter((id) => id !== targetId);

    if (removable.length) {
      try {
        await removeLabelsFromChat(channel.client, chatId, removable);
      } catch (err) {
        return {
          applied: true,
          verified: true,
          migrated: false,
          chatId,
          targetId,
          targetName: normalized.name,
          key: normalized.key,
          reason: `remove_failed:${err?.message || err}`,
        };
      }
    }

    const finalVerification = await verifyTargetAndRemoved(
      channel.client,
      chatId,
      targetId,
      removable,
    );
    persistManualLabels(clientId, finalVerification.items);

    if (finalVerification.verified === true && removable.length) {
      console.log(
        `[ETIQUETAS] migração confirmada em ${chatId}: canônica=${targetId} `
        + `removidas=${removable.join(',')}`,
      );
    }

    return {
      applied: true,
      verified: finalVerification.verified,
      migrated: finalVerification.verified === true && removable.length > 0,
      chatId,
      targetId,
      targetName: normalized.name,
      key: normalized.key,
      removedIds: removable,
      duplicateIdsRemoved: removable.filter((id) => duplicateIds.has(id)),
    };
  }

  return { applied: false, reason: 'chat_not_found', key: normalized.key };
}

async function removeGlobalList(client, id) {
  return client.page.evaluate(async ({ listId: targetId }) => {
    const WPP = window.WPP || null;
    if (!WPP?.lists?.remove) throw new Error('WPP.lists.remove indisponível');
    await WPP.lists.remove(String(targetId));
    return true;
  }, { listId: id });
}

async function trackedContactsAreMigrated(channel, definition, canonicalId, duplicateId) {
  const contacts = LabelStore.listContacts()
    .filter((record) => record.expected?.operational?.key === definition.key);

  for (const record of contacts) {
    const clientId = record.primaryChatId || record.aliases?.[0] || record.contactKey;
    const inspected = await inspectContactLabels(channel.client, clientId);
    if (!inspected.chatFound || inspected.available === false) return false;
    const ids = new Set(inspected.items.map((item) => String(item.id)));
    if (!ids.has(String(canonicalId)) || ids.has(String(duplicateId))) return false;
  }

  return true;
}

async function cleanupUnusedDuplicateLists(channel, catalogByKey, { keys = null } = {}) {
  if (!env.cleanupDuplicateOperationalLabels || !channel?.client?.page?.evaluate) {
    return { removed: [], skipped: [] };
  }

  const allowed = keys ? new Set(keys) : null;
  const removed = [];
  const skipped = [];

  await wait(500);
  for (const [key, entry] of Object.entries(catalogByKey || {})) {
    if (allowed && !allowed.has(key)) continue;
    const definition = entry?.definition;
    const canonicalId = listId(entry);
    if (!definition || !canonicalId) continue;

    const current = await readBusinessLists(channel.client);
    const duplicates = matchingLists(current, definition)
      .filter((item) => listId(item) !== canonicalId);

    for (const duplicate of duplicates) {
      const duplicateId = listId(duplicate);
      const count = listCount(duplicate);
      if (count > 0) {
        skipped.push({ key, id: duplicateId, reason: 'still_linked', count });
        continue;
      }

      const trackedMigrated = await trackedContactsAreMigrated(
        channel,
        definition,
        canonicalId,
        duplicateId,
      );
      if (!trackedMigrated) {
        skipped.push({ key, id: duplicateId, reason: 'tracked_contact_not_confirmed', count });
        continue;
      }

      try {
        await removeGlobalList(channel.client, duplicateId);
        await wait(450);
        const after = await readBusinessLists(channel.client);
        if (after.some((item) => listId(item) === duplicateId)) {
          skipped.push({ key, id: duplicateId, reason: 'remove_not_confirmed', count });
          continue;
        }
        removed.push({ key, id: duplicateId, canonicalId });
        console.log(
          `[ETIQUETAS] duplicata global removida após migração: ${duplicateId} `
          + `| canônica=${canonicalId} | ${definition.name}`,
        );
      } catch (err) {
        skipped.push({ key, id: duplicateId, reason: err?.message || String(err), count });
      }
    }
  }

  return { removed, skipped };
}

async function markContactUnread(channel, clientId, { source = 'seller-attention', force = false } = {}) {
  if (!env.markSellerClientUnread || !channel?.client?.page?.evaluate) {
    return { marked: false, reason: 'disabled' };
  }
  const record = LabelStore.getContact(clientId);
  const runtimeKey = record?.contactKey || Identity.getSessionKey(clientId);
  if (!force && sellerAttentionMarkedThisRuntime.has(runtimeKey)) {
    return { marked: true, alreadyMarkedThisRuntime: true };
  }

  for (const chatId of orderedCandidateIds(clientId)) {
    try {
      const result = await channel.client.page.evaluate(async ({ chatId: targetChatId }) => {
        const WPP = window.WPP || null;
        const StoreWindow = window.Store || null;
        let chat = StoreWindow?.Chat?.get?.(targetChatId) || null;
        if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
          try { chat = await StoreWindow.Chat.find(targetChatId); } catch (_) {}
        }
        if (!chat) return { marked: false, reason: 'chat_not_found' };
        if (!WPP?.chat?.markIsUnread) return { marked: false, reason: 'mark_unread_unavailable' };
        await WPP.chat.markIsUnread(targetChatId);
        return { marked: true, chatId: targetChatId };
      }, { chatId });

      if (result?.marked) {
        sellerAttentionMarkedThisRuntime.add(runtimeKey);
        LabelStore.markUnreadResult(clientId, { success: true, source });
        console.log(`[VENDEDOR] conversa marcada como não lida: ${result.chatId}`);
        return result;
      }
    } catch (err) {
      LabelStore.markUnreadResult(clientId, {
        success: false,
        source,
        error: err?.message || err,
      });
    }
  }

  LabelStore.markUnreadResult(clientId, {
    success: false,
    source,
    error: 'chat_not_found',
  });
  return { marked: false, reason: 'chat_not_found' };
}

async function assignSellerResponsibility(channel, clientId, sellerName, { source = 'seller-assignment' } = {}) {
  const canonical = canonicalSellerName(sellerName);
  if (!canonical) {
    console.warn(`[VENDEDOR] vendedor inválido: ${sellerName}`);
    return false;
  }
  LabelStore.registerContact({ clientId, source });
  const stored = LabelStore.setSellerResponsibility(clientId, canonical, { source });
  if (!stored) return false;
  sellerAttentionMarkedThisRuntime.delete(stored.contactKey);
  const unread = await markContactUnread(channel, clientId, { source, force: true });
  return {
    assigned: true,
    seller: canonical,
    unreadMarked: Boolean(unread?.marked),
    chatId: unread?.chatId || null,
  };
}

function clearSellerAttention(clientId, { source = 'seller-attended' } = {}) {
  const record = LabelStore.clearAttention(clientId, { source });
  if (record?.contactKey) sellerAttentionMarkedThisRuntime.delete(record.contactKey);
  return record;
}

function clearSellerResponsibility(clientId, { source = 'seller-cleared' } = {}) {
  const record = LabelStore.clearSellerResponsibility(clientId, { source });
  if (record?.contactKey) sellerAttentionMarkedThisRuntime.delete(record.contactKey);
  return record;
}

async function applyExpectedLabel(channel, clientId, definition, { source = 'flow' } = {}) {
  const normalized = normalizeDefinition(definition);
  if (!normalized) return false;
  LabelStore.registerContact({ clientId, source });
  LabelStore.setExpectedLabel(clientId, normalized, { source });

  const required = requiredLabelDefinitions();
  const definitions = required.some((item) => item.key === normalized.key)
    ? required
    : [...required, normalized];
  const ensured = await ensureRequiredCatalog(channel, { definitions });
  const result = await applyDefinitionWithCatalog(channel, clientId, normalized, ensured.catalog);

  let duplicateCleanup = { removed: [], skipped: [] };
  if (result?.verified === true) {
    duplicateCleanup = await cleanupUnusedDuplicateLists(channel, ensured.catalog, {
      keys: [normalized.key],
    });
  }

  LabelStore.markReconciled(clientId, {
    source,
    applied: Boolean(result?.applied),
    key: normalized.key,
    verified: result?.verified ?? null,
    migratedDuplicateIds: result?.duplicateIdsRemoved || [],
    duplicateListsRemoved: duplicateCleanup.removed,
    error: result?.applied ? null : result?.reason,
  });

  if (result?.applied) {
    console.log(
      `[ETIQUETAS] aplicada: ${normalized.name} | ${result.chatId} `
      + `| ID=${result.targetId} | verificada=${String(result.verified)}`,
    );
    return { ...result, duplicateCleanup };
  }
  console.warn(`[ETIQUETAS] não foi possível aplicar "${normalized.name}": ${result?.reason || 'falha'}`);
  return false;
}

async function applyNamedLabel(channel, clientId, target) {
  const known = definitionByName(target?.name);
  const definition = known || normalizeDefinition({
    ...target,
    key: `custom:${slug(target?.name)}`,
    kind: 'service',
  });
  return applyExpectedLabel(channel, clientId, definition, { source: 'applyNamedLabel' });
}

async function replaceServiceLabel(channel, clientId, service) {
  return applyExpectedLabel(channel, clientId, getServiceLabel(service), { source: `flow:${service}` });
}

async function assignSupportLabel(channel, clientId) {
  return applyExpectedLabel(channel, clientId, getSupportLabel(), { source: 'flow:support' });
}

async function reconcileTrackedContacts(channel, { contactKeys = null } = {}) {
  const ensured = await ensureRequiredCatalog(channel);
  const allowed = contactKeys ? new Set(contactKeys) : null;
  const contacts = LabelStore.listContacts().filter((item) => !allowed || allowed.has(item.contactKey));
  let reconciled = 0;
  let pending = 0;
  let failed = 0;
  let sellerAttentionMarked = 0;

  for (const original of contacts) {
    const clientId = original.primaryChatId || original.aliases?.[0] || original.contactKey;
    await observeContactLabels(channel, clientId, { force: true, source: 'startup-mobile' });
    const record = LabelStore.getContact(original.contactKey) || original;
    const operational = record.expected?.operational?.key
      ? (definitionByKey(record.expected.operational.key) || normalizeDefinition(record.expected.operational))
      : null;

    let contactOk = true;
    const results = [];
    if (operational) {
      const result = await applyDefinitionWithCatalog(channel, clientId, operational, ensured.catalog);
      results.push({
        key: operational.key,
        applied: Boolean(result?.applied),
        verified: result?.verified ?? null,
        migratedDuplicateIds: result?.duplicateIdsRemoved || [],
      });
      if (!result?.applied || result?.verified === false) contactOk = false;
    } else {
      pending += 1;
    }

    if (record.expected?.seller?.name && record.attention?.needsAttention !== false) {
      const unread = await markContactUnread(channel, clientId, { source: 'reconcile-seller-attention' });
      if (unread?.marked && !unread.alreadyMarkedThisRuntime) sellerAttentionMarked += 1;
    }

    if (operational && contactOk) reconciled += 1;
    if (operational && !contactOk) failed += 1;
    LabelStore.markReconciled(record.contactKey, {
      applied: operational ? contactOk : false,
      pendingClassification: !operational,
      results,
      seller: record.expected?.seller?.name || null,
      sellerAttention: Boolean(record.attention?.needsAttention),
      error: operational && !contactOk ? 'operational_label_failed' : null,
    });
    if (env.labelReconcileDelayMs) await wait(env.labelReconcileDelayMs);
  }

  const duplicateCleanup = await cleanupUnusedDuplicateLists(channel, ensured.catalog);

  return {
    catalogReady: ensured.ready,
    catalogMissing: ensured.missing,
    catalogDuplicates: ensured.duplicates,
    duplicateCleanup,
    total: contacts.length,
    reconciled,
    pending,
    failed,
    sellerAttentionMarked,
  };
}

async function initializeServiceLabels(channel) {
  return ensureRequiredCatalog(channel);
}

module.exports = {
  initializeServiceLabels,
  ensureRequiredCatalog,
  reconcileTrackedContacts,
  observeContactLabels,
  replaceServiceLabel,
  assignSupportLabel,
  applyNamedLabel,
  applyExpectedLabel,
  assignSellerResponsibility,
  clearSellerResponsibility,
  clearSellerAttention,
  markContactUnread,
  cleanupUnusedDuplicateLists,
  requiredLabelDefinitions,
  getServiceLabel,
  getSupportLabel,
  normalizeChatId: Identity.normalizeChatId,
  _test: {
    canonicalSellerName,
    definitionByName,
    desiredHex,
    expectedColorIndex,
    findByDefinition,
    listId,
    listName,
    matchingLists,
    nearestPaletteIndex,
    normalizeDefinition,
    normalizeName,
    orderedCandidateIds,
    resolveCanonicalList,
    resetRuntimeAttentionMarks() {
      sellerAttentionMarkedThisRuntime.clear();
    },
  },
};
