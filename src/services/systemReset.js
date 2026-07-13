'use strict';

const { env } = require('../config/env');
const Identity = require('./contactIdentity');
const Sessions = require('./leadStore');
const ContactLabels = require('./contactLabelStore');

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

function managedLabelNames() {
  return [...new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
  ].map((item) => String(item || '').trim()).filter(Boolean))];
}

function collectTrackedTargets() {
  const targets = new Map();

  const add = (clientId, contactKey = null, source = 'unknown') => {
    const id = String(clientId || '').trim();
    if (!id || /@g\.us$/i.test(id)) return;
    const key = contactKey || Identity.getSessionKey(id) || id;
    const existing = targets.get(key) || {
      contactKey: key,
      clientId: id,
      aliases: [],
      sources: [],
    };
    existing.clientId = existing.clientId || id;
    existing.aliases = [...new Set([...(existing.aliases || []), id])];
    existing.sources = [...new Set([...(existing.sources || []), source])];
    targets.set(key, existing);
  };

  for (const record of ContactLabels.listContacts()) {
    const id = record.primaryChatId || record.aliases?.[0] || null;
    if (!id) continue;
    add(id, record.contactKey, 'contact-labels');
    const target = targets.get(record.contactKey);
    if (target) {
      target.aliases = [...new Set([
        ...(target.aliases || []),
        ...(record.aliases || []),
      ].filter(Boolean))];
    }
  }

  for (const session of Sessions.listSessions()) {
    const id = session.chatId || session.contactIdentity?.primaryChatId || session.clientId || session.id;
    add(id, session.contactIdentity?.contactKey || session.id || null, 'sessions');
  }

  return [...targets.values()];
}

async function inspectManagedLabels(client, chatId, names) {
  if (!client?.page?.evaluate || !chatId) {
    return { chatFound: false, available: false, managedIds: [], allItems: [] };
  }

  return client.page.evaluate(async ({ chatId: targetChatId, names: expectedNames }) => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const wanted = new Set(expectedNames.map(normalize));
    const WPP = window.WPP || null;
    const StoreWindow = window.Store || null;

    let chat = StoreWindow?.Chat?.get?.(targetChatId) || null;
    if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
      try { chat = await StoreWindow.Chat.find(targetChatId); } catch (_) {}
    }
    if (!chat) return { chatFound: false, available: false, managedIds: [], allItems: [] };

    let catalog = [];
    try {
      if (WPP?.labels?.getAllLabels) {
        const value = await WPP.labels.getAllLabels();
        catalog = Array.isArray(value) ? value : Object.values(value || {});
      }
    } catch (_) {}

    const labelStore = StoreWindow?.Label || StoreWindow?.Labels || null;
    if (typeof labelStore?.getLabelsForModel !== 'function') {
      return { chatFound: true, available: false, managedIds: [], allItems: [] };
    }

    const value = labelStore.getLabelsForModel(chat) || [];
    const attached = Array.isArray(value) ? value : Object.values(value || {});
    const allItems = attached.map((entry) => {
      const id = String(entry?.id?._serialized || entry?.id || entry?.labelId || entry || '');
      const known = catalog.find((item) => String(
        item?.id?._serialized || item?.id || item?.labelId || '',
      ) === id) || null;
      return {
        id,
        name: String(entry?.name || entry?.label || known?.name || known?.label || ''),
      };
    }).filter((item) => item.id);

    return {
      chatFound: true,
      available: true,
      managedIds: allItems
        .filter((item) => wanted.has(normalize(item.name)))
        .map((item) => item.id),
      allItems,
    };
  }, { chatId, names });
}

async function removeManagedLabelsFromContact(channel, target) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { success: false, reason: 'page_unavailable', removedIds: [], chatId: null };
  }

  const names = managedLabelNames();
  const candidates = [...new Set([
    target?.clientId,
    ...(target?.aliases || []),
    ...Identity.getLabelCandidateIds(target?.clientId),
  ].filter(Boolean))];

  for (const chatId of candidates) {
    let inspected;
    try {
      inspected = await inspectManagedLabels(client, chatId, names);
    } catch (err) {
      inspected = { chatFound: false, available: false, error: err?.message || String(err) };
    }
    if (!inspected?.chatFound) continue;
    if (inspected.available === false) {
      return { success: false, reason: 'label_inspection_unavailable', removedIds: [], chatId };
    }

    const removeIds = [...new Set((inspected.managedIds || []).map(String).filter(Boolean))];
    if (!removeIds.length) {
      return { success: true, removedIds: [], chatId, alreadyClean: true };
    }

    try {
      await client.page.evaluate(async ({ chatId: targetChatId, removeIds: ids }) => {
        const WPP = window.WPP || null;
        if (!WPP?.lists?.removeChats) throw new Error('WPP.lists.removeChats indisponível');
        for (const id of ids) await WPP.lists.removeChats(String(id), [targetChatId]);
      }, { chatId, removeIds });
    } catch (err) {
      return {
        success: false,
        reason: err?.message || String(err),
        removedIds: [],
        chatId,
      };
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await wait(400);
      const after = await inspectManagedLabels(client, chatId, names).catch(() => null);
      if (after?.chatFound && after.available !== false && !(after.managedIds || []).length) {
        return { success: true, removedIds: removeIds, chatId, verified: true };
      }
    }

    return {
      success: false,
      reason: 'label_removal_not_confirmed',
      removedIds: removeIds,
      chatId,
    };
  }

  return { success: false, reason: 'chat_not_found', removedIds: [], chatId: null };
}

async function clearContactNote(channel, clientId) {
  if (typeof channel?.setContactNote !== 'function') {
    return { success: false, reason: 'set_note_unavailable' };
  }
  try {
    const result = await channel.setContactNote(clientId, '');
    return result === false
      ? { success: false, reason: 'note_clear_returned_false' }
      : { success: true };
  } catch (err) {
    return { success: false, reason: err?.message || String(err) };
  }
}

async function resetSystemWithWhatsAppCleanup({
  channel,
  removeLabels = removeManagedLabelsFromContact,
  clearNote = clearContactNote,
} = {}) {
  const targets = collectTrackedTargets();
  const results = [];
  const failedContactKeys = [];
  let labelsRemoved = 0;
  let notesCleared = 0;

  for (const target of targets) {
    const labelResult = await removeLabels(channel, target);
    const noteResult = await clearNote(channel, target.clientId, target);
    labelsRemoved += Array.isArray(labelResult?.removedIds) ? labelResult.removedIds.length : 0;
    if (noteResult?.success) notesCleared += 1;

    const success = Boolean(labelResult?.success && noteResult?.success);
    if (!success && target.contactKey) failedContactKeys.push(target.contactKey);
    results.push({
      contactKey: target.contactKey,
      clientId: target.clientId,
      success,
      labelResult,
      noteResult,
    });
  }

  const contactReset = ContactLabels.resetContacts({
    preserveCatalog: true,
    keepContactKeys: failedContactKeys,
  });
  const localReset = Sessions.resetSystem();

  return {
    ...localReset,
    trackedContacts: targets.length,
    contactsCleaned: results.filter((item) => item.success).length,
    cleanupFailures: results.filter((item) => !item.success).length,
    labelsRemoved,
    notesCleared,
    remainingTrackedContacts: contactReset.remainingContactCount,
    results,
  };
}

module.exports = {
  resetSystemWithWhatsAppCleanup,
  collectTrackedTargets,
  removeManagedLabelsFromContact,
  clearContactNote,
  managedLabelNames,
  _test: {
    inspectManagedLabels,
    normalizeName,
  },
};
