'use strict';

const { env } = require('../config/env');

const SELLER_DISPLAY_NAMES = Object.freeze({
  adriano: 'Adriano',
  ana: 'Ana',
  emy: 'Emy',
  'c. eduardo': 'C. Eduardo',
});

const LEGACY_SELLER_ALIASES = Object.freeze({
  aninha: 'ana',
  carlos: 'c. eduardo',
});

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function serializedId(value) {
  return String(
    value?._serialized
    || value?.id?._serialized
    || value?.id
    || value?.labelId
    || value
    || '',
  ).trim();
}

function labelName(value) {
  return String(value?.name || value?.label || '').trim();
}

function labelCount(value) {
  const count = Number(value?.count);
  return Number.isFinite(count) ? count : 0;
}

function compareLabels(a, b) {
  const byCount = labelCount(b) - labelCount(a);
  if (byCount) return byCount;
  return serializedId(a).localeCompare(serializedId(b), 'pt-BR', { numeric: true });
}

function currentSellerNames() {
  const configured = Object.keys(env.sellerLabelRules || {}).map(normalizeName).filter(Boolean);
  const required = Object.keys(SELLER_DISPLAY_NAMES);
  return [...new Set([...required, ...configured])];
}

function displaySellerName(normalizedName) {
  if (SELLER_DISPLAY_NAMES[normalizedName]) return SELLER_DISPLAY_NAMES[normalizedName];
  return String(normalizedName || '')
    .split(/\s+/)
    .map((part) => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : '')
    .join(' ')
    .trim();
}

function buildSellerLabelMigrationPlan(labels = []) {
  const normalizedLabels = (Array.isArray(labels) ? labels : [])
    .map((item) => ({
      id: serializedId(item),
      name: labelName(item),
      normalizedName: normalizeName(labelName(item)),
      count: labelCount(item),
    }))
    .filter((item) => item.id && item.normalizedName);

  const byName = new Map();
  for (const item of normalizedLabels) {
    const current = byName.get(item.normalizedName) || [];
    current.push(item);
    byName.set(item.normalizedName, current);
  }

  const canonical = {};
  const missingTargets = [];
  const operations = [];

  for (const sellerName of currentSellerNames()) {
    const matches = [...(byName.get(sellerName) || [])].sort(compareLabels);
    if (!matches.length) {
      missingTargets.push(displaySellerName(sellerName));
      continue;
    }

    const target = matches[0];
    canonical[sellerName] = target;

    for (const duplicate of matches.slice(1)) {
      operations.push({
        type: 'duplicate',
        sourceId: duplicate.id,
        sourceName: duplicate.name,
        sourceCount: duplicate.count,
        targetId: target.id,
        targetName: target.name,
      });
    }
  }

  for (const [legacyName, currentName] of Object.entries(LEGACY_SELLER_ALIASES)) {
    const target = canonical[currentName];
    if (!target) continue;

    for (const legacy of byName.get(legacyName) || []) {
      if (legacy.id === target.id) continue;
      operations.push({
        type: 'legacy',
        sourceId: legacy.id,
        sourceName: legacy.name,
        sourceCount: legacy.count,
        targetId: target.id,
        targetName: target.name,
      });
    }
  }

  const seenSources = new Set();
  const uniqueOperations = operations.filter((operation) => {
    if (!operation.sourceId || !operation.targetId || operation.sourceId === operation.targetId) return false;
    if (seenSources.has(operation.sourceId)) return false;
    seenSources.add(operation.sourceId);
    return true;
  });

  return {
    canonical,
    labels: normalizedLabels,
    missingTargets,
    operations: uniqueOperations,
  };
}

async function readBusinessLabels(client) {
  if (!client?.page?.evaluate) throw new Error('LABEL_PAGE_UNAVAILABLE');
  return client.page.evaluate(async () => {
    const WPP = window.WPP || null;
    if (typeof WPP?.labels?.getAllLabels !== 'function') throw new Error('LABEL_LIST_API_UNAVAILABLE');
    const raw = await WPP.labels.getAllLabels();
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    return list.map((item) => ({
      id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
      name: String(item?.name || item?.label || ''),
      count: Number(item?.count || 0),
    }));
  });
}

function extractChatId(chat = {}) {
  return String(
    chat?.id?._serialized
    || chat?.id
    || chat?.chatId
    || chat?.contact?.id?._serialized
    || '',
  ).trim();
}

async function warmChatIds(client) {
  for (const method of ['listChats', 'getAllChats', 'getAllChatsWithMessages']) {
    if (typeof client?.[method] !== 'function') continue;
    try {
      const raw = await client[method]();
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      const ids = [...new Set(list.map(extractChatId).filter(Boolean))];
      if (ids.length) return ids;
    } catch (error) {
      console.warn(`[LISTAS][MIGRAÇÃO] ${method} falhou:`, error?.message || error);
    }
  }

  if (!client?.page?.evaluate) return [];
  try {
    return await client.page.evaluate(() => {
      const Store = window.Store || null;
      const raw = Store?.Chat?.getModelsArray?.() || Store?.Chat?.models || [];
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      return [...new Set(list.map((chat) => String(chat?.id?._serialized || chat?.id || '')).filter(Boolean))];
    });
  } catch (_) {
    return [];
  }
}

async function scanLabelUsage(client, chatIds, labelIds) {
  const usage = Object.fromEntries((labelIds || []).map((id) => [String(id), []]));
  const chunks = [];
  for (let index = 0; index < chatIds.length; index += 250) chunks.push(chatIds.slice(index, index + 250));

  for (const chunk of chunks) {
    const result = await client.page.evaluate(async ({ chatIds: ids, labelIds: wantedIds }) => {
      const Store = window.Store || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      const output = Object.fromEntries((wantedIds || []).map((id) => [String(id), []]));
      const getId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '').trim();
      if (typeof labelStore?.getLabelsForModel !== 'function') return output;

      for (const chatId of ids || []) {
        let chat = null;
        try {
          chat = Store?.Chat?.get?.(chatId) || null;
          if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
        } catch (_) {}
        if (!chat) continue;

        const raw = labelStore.getLabelsForModel(chat) || [];
        const attached = Array.isArray(raw) ? raw : Object.values(raw || {});
        const attachedIds = new Set(attached.map(getId).filter(Boolean));
        for (const labelId of wantedIds || []) {
          if (attachedIds.has(String(labelId))) output[String(labelId)].push(chatId);
        }
      }
      return output;
    }, { chatIds: chunk, labelIds });

    for (const [labelId, ids] of Object.entries(result || {})) {
      usage[labelId] = [...new Set([...(usage[labelId] || []), ...(ids || [])])];
    }
  }

  return usage;
}

async function migrateOperation(client, operation, chatIds) {
  const result = { moved: [], retained: [], failed: [] };
  const chunks = [];
  for (let index = 0; index < chatIds.length; index += 100) chunks.push(chatIds.slice(index, index + 100));

  for (const chunk of chunks) {
    const batch = await client.page.evaluate(async ({ chatIds: ids, sourceId, targetId }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const getId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '').trim();
      const readAttached = async (chatId) => {
        let chat = null;
        try {
          chat = Store?.Chat?.get?.(chatId) || null;
          if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
        } catch (_) {}
        if (!chat || typeof labelStore?.getLabelsForModel !== 'function') return null;
        const raw = labelStore.getLabelsForModel(chat) || [];
        const list = Array.isArray(raw) ? raw : Object.values(raw || {});
        return new Set(list.map(getId).filter(Boolean));
      };

      const sourceChats = [];
      const alreadyTarget = [];
      for (const chatId of ids || []) {
        const attached = await readAttached(chatId);
        if (!attached || !attached.has(String(sourceId))) continue;
        sourceChats.push(chatId);
        if (attached.has(String(targetId))) alreadyTarget.push(chatId);
      }

      const needsTarget = sourceChats.filter((chatId) => !alreadyTarget.includes(chatId));
      if (needsTarget.length) {
        if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
          await WPP.labels.addOrRemoveLabels(needsTarget, [{ labelId: String(targetId), type: 'add' }]);
        } else if (typeof WPP?.lists?.addChats === 'function') {
          await WPP.lists.addChats(String(targetId), needsTarget);
        } else {
          return { moved: [], retained: sourceChats, failed: sourceChats, reason: 'LABEL_ADD_API_UNAVAILABLE' };
        }
        await wait(600);
      }

      const verifiedTarget = [];
      const failed = [];
      for (const chatId of sourceChats) {
        const attached = await readAttached(chatId);
        if (attached?.has(String(targetId))) verifiedTarget.push(chatId);
        else failed.push(chatId);
      }

      if (verifiedTarget.length) {
        if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
          await WPP.labels.addOrRemoveLabels(verifiedTarget, [{ labelId: String(sourceId), type: 'remove' }]);
        } else if (typeof WPP?.lists?.removeChats === 'function') {
          await WPP.lists.removeChats(String(sourceId), verifiedTarget);
        } else {
          return { moved: [], retained: sourceChats, failed: verifiedTarget, reason: 'LABEL_REMOVE_API_UNAVAILABLE' };
        }
        await wait(500);
      }

      const moved = [];
      const retained = [];
      for (const chatId of sourceChats) {
        const attached = await readAttached(chatId);
        if (attached && attached.has(String(targetId)) && !attached.has(String(sourceId))) moved.push(chatId);
        else retained.push(chatId);
      }

      return { moved, retained, failed };
    }, {
      chatIds: chunk,
      sourceId: operation.sourceId,
      targetId: operation.targetId,
    });

    result.moved.push(...(batch?.moved || []));
    result.retained.push(...(batch?.retained || []));
    result.failed.push(...(batch?.failed || []));
  }

  result.moved = [...new Set(result.moved)];
  result.retained = [...new Set(result.retained)];
  result.failed = [...new Set(result.failed)];
  return result;
}

async function deleteEmptyLabel(client, sourceId) {
  return client.page.evaluate(async ({ labelId }) => {
    const WPP = window.WPP || null;
    if (typeof WPP?.labels?.deleteLabel !== 'function') return { deleted: false, reason: 'LABEL_DELETE_API_UNAVAILABLE' };
    try {
      await WPP.labels.deleteLabel(String(labelId));
      return { deleted: true };
    } catch (error) {
      return { deleted: false, reason: String(error?.message || error?.text || error || 'DELETE_FAILED') };
    }
  }, { labelId: String(sourceId) });
}

async function migrateSellerLabels(channel, options = {}) {
  const apply = options.apply === true;
  const client = channel?.client;
  if (!client?.page?.evaluate) throw new Error('WHATSAPP_PAGE_UNAVAILABLE');

  const labelsBefore = await readBusinessLabels(client);
  const plan = buildSellerLabelMigrationPlan(labelsBefore);
  const chatIds = await warmChatIds(client);
  const sourceIds = plan.operations.map((operation) => operation.sourceId);
  const usageBefore = sourceIds.length && chatIds.length
    ? await scanLabelUsage(client, chatIds, sourceIds)
    : {};

  const report = {
    apply,
    chatCount: chatIds.length,
    missingTargets: plan.missingTargets,
    operations: [],
  };

  if (!apply) {
    report.operations = plan.operations.map((operation) => ({
      ...operation,
      attachedChatsFound: (usageBefore[operation.sourceId] || []).length,
    }));
    return report;
  }

  if (!chatIds.length) throw new Error('Nenhuma conversa foi carregada; migração cancelada sem alterar etiquetas.');
  if (plan.missingTargets.length) {
    throw new Error(`Etiquetas corretas ausentes: ${plan.missingTargets.join(', ')}. Migração cancelada.`);
  }

  for (const operation of plan.operations) {
    const attachedChats = usageBefore[operation.sourceId] || [];
    const movement = await migrateOperation(client, operation, attachedChats);
    const remainingUsage = await scanLabelUsage(client, chatIds, [operation.sourceId]);
    const labelsAfterMove = await readBusinessLabels(client);
    const sourceAfter = labelsAfterMove.find((item) => serializedId(item) === operation.sourceId) || null;
    const remainingChats = remainingUsage[operation.sourceId] || [];
    const reportedRemaining = sourceAfter ? labelCount(sourceAfter) : 0;

    let deletion = { deleted: !sourceAfter, reason: sourceAfter ? 'SOURCE_NOT_EMPTY_OR_NOT_VERIFIED' : null };
    if (sourceAfter && remainingChats.length === 0 && reportedRemaining === 0) {
      deletion = await deleteEmptyLabel(client, operation.sourceId);
      if (deletion.deleted) {
        const finalLabels = await readBusinessLabels(client);
        deletion.deleted = !finalLabels.some((item) => serializedId(item) === operation.sourceId);
        if (!deletion.deleted) deletion.reason = 'LABEL_STILL_EXISTS_AFTER_DELETE';
      }
    }

    report.operations.push({
      ...operation,
      attachedChatsFound: attachedChats.length,
      moved: movement.moved.length,
      retained: movement.retained.length,
      failed: movement.failed.length,
      remainingChats: remainingChats.length,
      reportedRemaining,
      labelDeleted: deletion.deleted === true,
      deletionReason: deletion.reason || null,
    });
  }

  return report;
}

module.exports = {
  LEGACY_SELLER_ALIASES,
  SELLER_DISPLAY_NAMES,
  buildSellerLabelMigrationPlan,
  currentSellerNames,
  displaySellerName,
  labelCount,
  labelName,
  migrateSellerLabels,
  normalizeName,
  readBusinessLabels,
  scanLabelUsage,
  serializedId,
  warmChatIds,
};
