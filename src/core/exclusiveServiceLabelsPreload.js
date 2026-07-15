'use strict';

const ServiceLabels = require('./serviceLabels');
const Identity = require('../services/contactIdentity');
const { env } = require('../config/env');

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function operationalLabelNames() {
  return [...new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ].map((item) => normalizeName(item)).filter(Boolean))];
}

function orderedCandidateIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  let known = [];
  try { known = Identity.getLabelCandidateIds(clientId); } catch (_) {}
  return [...new Set([direct, ...known].map(Identity.normalizeChatId).filter(Boolean))];
}

function classifyAttachedLabels(items = [], targetName = '', explicitTargetId = '') {
  const managed = new Set(operationalLabelNames());
  const wantedName = normalizeName(targetName);
  const explicitId = String(explicitTargetId || '').trim();
  const normalized = (items || []).map((item) => ({
    id: String(item?.id?._serialized || item?.id || item?.labelId || '').trim(),
    name: String(item?.name || item?.label || '').trim(),
  })).filter((item) => item.id || item.name);

  const targetItems = normalized.filter((item) => normalizeName(item.name) === wantedName);
  if (!targetItems.length) {
    return {
      targetPresent: false,
      preferredTargetId: '',
      remove: [],
      preserve: normalized,
    };
  }

  const preferredTargetId = targetItems.some((item) => item.id === explicitId)
    ? explicitId
    : targetItems[0].id;

  const remove = [];
  const preserve = [];

  for (const item of normalized) {
    const itemName = normalizeName(item.name);
    const isOperational = managed.has(itemName);
    const isPreferredTarget = itemName === wantedName && item.id === preferredTargetId;

    if (isOperational && !isPreferredTarget) remove.push(item);
    else preserve.push(item);
  }

  return {
    targetPresent: true,
    preferredTargetId,
    remove,
    preserve,
  };
}

function markInternalAliases(channel, clientId) {
  if (typeof channel?.__markInternalLabelOperation !== 'function') return;
  for (const chatId of orderedCandidateIds(clientId)) {
    try { channel.__markInternalLabelOperation(chatId); } catch (_) {}
  }
}

async function enforceExclusiveOperationalLabel(channel, clientId, targetName, explicitTargetId = '') {
  const client = channel?.client;
  const candidates = orderedCandidateIds(clientId);
  const managedNames = operationalLabelNames();
  const wantedName = normalizeName(targetName);

  if (!client?.page?.evaluate || !candidates.length || !wantedName) {
    return { enforced: false, reason: 'LABEL_PAGE_UNAVAILABLE' };
  }

  markInternalAliases(channel, clientId);

  try {
    const result = await client.page.evaluate(async ({ candidates, managedNames, targetName, explicitTargetId }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const serializedId = (value) => String(
        value?._serialized
        || value?.id?._serialized
        || value?.id
        || value?.labelId
        || value
        || ''
      ).trim();

      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { enforced: false, reason: 'ATTACHED_LABELS_UNAVAILABLE', chats: [] };
      }

      let allLabels = [];
      try {
        const raw = await WPP?.labels?.getAllLabels?.();
        allLabels = Array.isArray(raw) ? raw : Object.values(raw || {});
      } catch (_) {}

      const globalById = new Map(allLabels.map((item) => [serializedId(item), item]));
      const managed = new Set((managedNames || []).map(normalize).filter(Boolean));
      const wanted = normalize(targetName);
      const output = [];

      for (const chatId of candidates) {
        let chat = null;
        try {
          chat = Store?.Chat?.get?.(chatId) || null;
          if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
        } catch (_) {}
        if (!chat) continue;

        const readAttached = () => {
          const raw = labelStore.getLabelsForModel(chat) || [];
          const list = Array.isArray(raw) ? raw : Object.values(raw || {});
          return list.map((entry) => {
            const id = serializedId(entry);
            const known = globalById.get(id) || null;
            return {
              id,
              name: String(entry?.name || entry?.label || known?.name || known?.label || '').trim(),
            };
          }).filter((item) => item.id || item.name);
        };

        const before = readAttached();
        const exactTargets = before.filter((item) => normalize(item.name) === wanted);

        // Nunca remove a etiqueta operacional anterior sem antes confirmar que a
        // nova realmente apareceu no contato. Isso evita deixar o cliente sem setor.
        if (!exactTargets.length) {
          output.push({
            chatId,
            enforced: false,
            targetPresent: false,
            reason: 'TARGET_NOT_CONFIRMED',
            removed: [],
            preserved: before.map((item) => item.name),
            operational: before.filter((item) => managed.has(normalize(item.name))).map((item) => item.name),
          });
          continue;
        }

        let preferredTargetId = String(explicitTargetId || '').trim();
        if (!exactTargets.some((item) => item.id === preferredTargetId)) {
          preferredTargetId = exactTargets[0].id;
        }

        const remove = before.filter((item) => {
          const itemName = normalize(item.name);
          if (!managed.has(itemName)) return false;
          return !(itemName === wanted && item.id === preferredTargetId);
        });

        if (remove.length) {
          const operations = remove.map((item) => ({ labelId: item.id, type: 'remove' }));
          if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
            await WPP.labels.addOrRemoveLabels([chatId], operations);
          } else if (typeof WPP?.lists?.removeChats === 'function') {
            for (const item of remove) await WPP.lists.removeChats(item.id, [chatId]);
          } else {
            output.push({
              chatId,
              enforced: false,
              reason: 'LABEL_REMOVE_API_UNAVAILABLE',
              removed: [],
              preserved: before.map((item) => item.name),
            });
            continue;
          }
          await wait(700);
        }

        const after = readAttached();
        const remainingOperational = after.filter((item) => managed.has(normalize(item.name)));
        const targetPresent = remainingOperational.some((item) => normalize(item.name) === wanted);
        const wrongOperational = remainingOperational.filter((item) => {
          if (normalize(item.name) !== wanted) return true;
          return item.id !== preferredTargetId;
        });

        output.push({
          chatId,
          enforced: targetPresent && wrongOperational.length === 0,
          targetPresent,
          removed: remove.map((item) => item.name),
          preserved: after.filter((item) => !managed.has(normalize(item.name))).map((item) => item.name),
          operational: remainingOperational.map((item) => item.name),
          wrongOperational: wrongOperational.map((item) => item.name),
        });
      }

      if (!output.length) return { enforced: false, reason: 'CONTACT_CHAT_NOT_FOUND', chats: [] };
      return {
        enforced: output.some((item) => item.enforced),
        chats: output,
      };
    }, {
      candidates,
      managedNames,
      targetName: String(targetName || '').trim(),
      explicitTargetId: String(explicitTargetId || '').trim(),
    });

    const changed = (result?.chats || []).flatMap((item) => item.removed || []);
    const preserved = (result?.chats || []).flatMap((item) => item.preserved || []);
    console.log(
      `[LISTAS] etiqueta operacional exclusiva | contato=${clientId} | alvo="${targetName}" `
      + `| removidas=${[...new Set(changed)].join(', ') || 'nenhuma'} `
      + `| manuais/vendedor preservadas=${[...new Set(preserved)].join(', ') || 'nenhuma'}`,
    );
    return result;
  } catch (error) {
    console.warn(`[LISTAS] falha ao substituir etiqueta operacional de ${clientId}:`, error?.message || error);
    return { enforced: false, reason: error?.message || String(error) };
  } finally {
    markInternalAliases(channel, clientId);
  }
}

function isApplied(result) {
  return result === true || result?.applied === true;
}

function isOperationalTarget(target = {}) {
  return operationalLabelNames().includes(normalizeName(target?.name));
}

function installExclusiveServiceLabels() {
  if (ServiceLabels.__exclusiveServiceLabelsInstalled) return ServiceLabels;

  const originalReplaceServiceLabel = ServiceLabels.replaceServiceLabel.bind(ServiceLabels);
  const originalApplyNamedLabel = ServiceLabels.applyNamedLabel.bind(ServiceLabels);

  ServiceLabels.replaceServiceLabel = async function replaceServiceLabelExclusively(channel, clientId, service) {
    const result = await originalReplaceServiceLabel(channel, clientId, service);
    if (!isApplied(result)) return result;

    const target = ServiceLabels.getServiceLabel(service);
    const cleanup = await enforceExclusiveOperationalLabel(
      channel,
      clientId,
      target?.name,
      result?.targetId,
    );

    return typeof result === 'object' ? { ...result, exclusiveCleanup: cleanup } : result;
  };

  ServiceLabels.applyNamedLabel = async function applyOperationalLabelExclusively(channel, clientId, target) {
    const result = await originalApplyNamedLabel(channel, clientId, target);
    if (!isApplied(result) || !isOperationalTarget(target)) return result;

    const cleanup = await enforceExclusiveOperationalLabel(
      channel,
      clientId,
      target?.name,
      result?.targetId,
    );

    return typeof result === 'object' ? { ...result, exclusiveCleanup: cleanup } : result;
  };

  ServiceLabels.__exclusiveServiceLabelsInstalled = true;
  return ServiceLabels;
}

installExclusiveServiceLabels();

module.exports = {
  classifyAttachedLabels,
  enforceExclusiveOperationalLabel,
  installExclusiveServiceLabels,
  isOperationalTarget,
  normalizeName,
  operationalLabelNames,
  orderedCandidateIds,
};
