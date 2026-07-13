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
    const key = session.contactIdentity?.contactKey || session.id || null;
    const target = key ? targets.get(key) : null;
    if (target) {
      target.aliases = [...new Set([
        ...(target.aliases || []),
        ...(session.contactIdentity?.aliases || []),
        session.contactIdentity?.lid,
        session.contactIdentity?.cUsId,
      ].filter(Boolean))];
    }
  }

  return [...targets.values()];
}

function targetCandidates(target) {
  return [...new Set([
    target?.clientId,
    ...(target?.aliases || []),
    ...Identity.getLabelCandidateIds(target?.clientId),
  ].map((item) => String(item || '').trim()).filter(Boolean))];
}

async function removeManagedLabelsFromContact(channel, target) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { success: false, reason: 'page_unavailable', removedIds: [], chatId: null };
  }

  const names = managedLabelNames();
  const candidates = targetCandidates(target);
  let lastFailure = null;

  for (const chatId of candidates) {
    let result;
    try {
      result = await client.page.evaluate(async ({ chatId: requestedChatId, names: expectedNames }) => {
        const normalize = (value) => String(value || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        const wanted = new Set(expectedNames.map(normalize));
        const WPP = window.WPP || null;
        const StoreWindow = window.Store || null;
        const waitBrowser = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const itemId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '');
        const itemName = (item) => String(item?.name || item?.label || '');

        const resolveChat = async () => {
          let chat = StoreWindow?.Chat?.get?.(requestedChatId) || null;
          if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
            try { chat = await StoreWindow.Chat.find(requestedChatId); } catch (_) {}
          }
          return chat;
        };

        const chat = await resolveChat();
        if (!chat) return { success: false, chatFound: false, reason: 'chat_not_found' };
        const resolvedChatId = String(chat?.id?._serialized || chat?.id || requestedChatId);

        if (!WPP?.labels?.getAllLabels) {
          return { success: false, chatFound: true, reason: 'label_catalog_unavailable', chatId: resolvedChatId };
        }
        const catalogValue = await WPP.labels.getAllLabels();
        const catalog = Array.isArray(catalogValue) ? catalogValue : Object.values(catalogValue || {});
        const managed = catalog.filter((item) => wanted.has(normalize(itemName(item))));
        const managedIds = [...new Set(managed.map(itemId).filter(Boolean))];
        if (!managedIds.length) {
          return {
            success: true,
            chatFound: true,
            chatId: resolvedChatId,
            removedIds: [],
            alreadyClean: true,
            reason: 'managed_labels_not_in_catalog',
          };
        }

        const readAttachedIds = async () => {
          const refreshed = await resolveChat();
          if (!refreshed) return { available: false, ids: [] };
          const ids = new Set();
          let available = false;

          if (Array.isArray(refreshed.labels)) {
            available = true;
            for (const id of refreshed.labels) {
              const value = itemId(id);
              if (value) ids.add(value);
            }
          }

          const labelStore = StoreWindow?.Label || StoreWindow?.Labels || null;
          if (typeof labelStore?.getLabelsForModel === 'function') {
            available = true;
            const value = labelStore.getLabelsForModel(refreshed) || [];
            for (const entry of (Array.isArray(value) ? value : Object.values(value || {}))) {
              const id = itemId(entry);
              if (id) ids.add(id);
            }
          }
          return { available, ids: [...ids] };
        };

        const before = await readAttachedIds();
        const attachedManagedBefore = before.available
          ? managedIds.filter((id) => before.ids.includes(id))
          : [...managedIds];

        if (WPP?.labels?.addOrRemoveLabels) {
          await WPP.labels.addOrRemoveLabels(
            resolvedChatId,
            managedIds.map((labelId) => ({ labelId: String(labelId), type: 'remove' })),
          );
        } else if (WPP?.lists?.removeChats) {
          for (const id of managedIds) await WPP.lists.removeChats(String(id), [resolvedChatId]);
        } else {
          return { success: false, chatFound: true, reason: 'label_remove_api_unavailable', chatId: resolvedChatId };
        }

        let after = { available: false, ids: [] };
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (attempt > 0) await waitBrowser(350);
          after = await readAttachedIds();
          if (after.available && !managedIds.some((id) => after.ids.includes(id))) break;
        }

        const remainingIds = after.available
          ? managedIds.filter((id) => after.ids.includes(id))
          : [];
        return {
          success: after.available ? remainingIds.length === 0 : true,
          chatFound: true,
          chatId: resolvedChatId,
          removedIds: attachedManagedBefore.filter((id) => !remainingIds.includes(id)),
          requestedIds: managedIds,
          remainingIds,
          verified: after.available && remainingIds.length === 0,
          verificationAvailable: after.available,
          reason: after.available && remainingIds.length ? 'label_removal_not_confirmed' : null,
        };
      }, { chatId, names });
    } catch (err) {
      result = { success: false, chatFound: false, reason: err?.message || String(err), chatId };
    }

    if (result?.success) return result;
    lastFailure = result;
    if (result?.chatFound) return result;
  }

  return lastFailure || { success: false, reason: 'chat_not_found', removedIds: [], chatId: null };
}

async function clearContactNote(channel, clientId, target = null) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { success: false, reason: 'page_unavailable', chatId: null };
  }

  const candidates = targetCandidates(target || { clientId });
  let lastFailure = null;

  for (const chatId of candidates) {
    let result;
    try {
      result = await client.page.evaluate(async ({ chatId: requestedChatId }) => {
        const WPP = window.WPP || null;
        const StoreWindow = window.Store || null;
        const waitBrowser = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const stripInvisible = (value) => String(value || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();

        const resolveChat = async () => {
          let chat = StoreWindow?.Chat?.get?.(requestedChatId) || null;
          if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
            try { chat = await StoreWindow.Chat.find(requestedChatId); } catch (_) {}
          }
          return chat;
        };

        const chat = await resolveChat();
        if (!chat) return { success: false, chatFound: false, reason: 'chat_not_found' };
        const resolvedChatId = String(chat?.id?._serialized || chat?.id || requestedChatId);
        const chatJid = String(
          (typeof chat?.id?.toJid === 'function' ? chat.id.toJid() : null)
          || chat?.id?._serialized
          || chat?.id
          || resolvedChatId,
        );

        const getNote = async () => {
          if (WPP?.chat?.getNotes) {
            try { return await WPP.chat.getNotes(resolvedChatId); } catch (_) {}
          }
          try {
            const noteAction = window.require?.('WAWebNoteAction');
            if (noteAction?.retrieveOnlyNoteForChatJid) {
              return await noteAction.retrieveOnlyNoteForChatJid(chatJid);
            }
          } catch (_) {}
          return undefined;
        };

        const existing = await getNote();
        if (existing === null) {
          return { success: true, chatFound: true, chatId: resolvedChatId, alreadyClean: true, mode: 'already-empty' };
        }
        if (existing === undefined) {
          return { success: false, chatFound: true, chatId: resolvedChatId, reason: 'note_read_api_unavailable' };
        }

        let deleteError = null;
        try {
          const requireModule = window.require;
          if (typeof requireModule !== 'function') throw new Error('window.require indisponível');

          const noteAction = requireModule('WAWebNoteAction');
          const noteSyncModule = requireModule('WAWebNoteSync');
          const noteSync = noteSyncModule?.default || noteSyncModule;
          const syncdGetChat = requireModule('WAWebSyncdGetChat');
          const widFactory = requireModule('WAWebWidFactory');
          const widToJid = requireModule('WAWebWidToJid');
          const actionUtils = requireModule('WAWebSyncdActionUtils');
          const serverProto = requireModule('WAWebProtobufsServerSync.pb');
          const syncdCore = requireModule('WAWebSyncdCoreApi');
          const schemaNote = requireModule('WAWebSchemaNote');
          const noteCollectionModule = requireModule('WAWebNoteCollection');

          const note = noteAction?.retrieveOnlyNoteForChatJid
            ? await noteAction.retrieveOnlyNoteForChatJid(chatJid)
            : existing;
          if (!note?.id) throw new Error('nota não localizada para exclusão');
          if (!noteSync?.getAction || !noteSync?.getVersion || !noteSync?.resolveNoteId) {
            throw new Error('WAWebNoteSync incompleto');
          }

          const sourceJid = String(note.chatJid || chatJid);
          const mutationIndex = await syncdGetChat.getChatJidMutationIndexForChat(
            widFactory.createWid(sourceJid),
            noteSync.getAction(),
          );
          const mutationChatJid = widToJid.widToChatJid(widFactory.createWid(mutationIndex));
          const mutationNoteId = await noteSync.resolveNoteId(
            sourceJid,
            mutationChatJid,
            String(note.id),
          );
          const operation = serverProto?.SyncdMutation$SyncdOperation?.SET;
          if (operation === undefined) throw new Error('operação Syncd SET indisponível');

          const mutation = actionUtils.buildPendingMutation({
            collection: noteSync.collectionName,
            indexArgs: [mutationNoteId],
            value: { noteEditAction: { deleted: true } },
            version: noteSync.getVersion(),
            operation,
            timestamp: Date.now(),
            action: noteSync.getAction(),
          });

          await syncdCore.lockForSync(['note'], [mutation], async () => {
            const table = schemaNote.getNoteTable();
            await table.remove(mutationNoteId);
            if (String(note.id) !== String(mutationNoteId)) {
              try { await table.remove(String(note.id)); } catch (_) {}
            }
          });

          const noteCollection = noteCollectionModule?.NoteCollection;
          if (noteCollection?.purgeNotesByChatJid) noteCollection.purgeNotesByChatJid(sourceJid);
          else if (noteCollection?.remove) noteCollection.remove([String(note.id), String(mutationNoteId)]);

          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (attempt > 0) await waitBrowser(350);
            const after = await getNote();
            if (after === null || (after && !stripInvisible(after.content))) {
              return {
                success: true,
                chatFound: true,
                chatId: resolvedChatId,
                mode: after === null ? 'deleted' : 'blank-after-delete',
                verified: true,
              };
            }
          }
          deleteError = 'note_deletion_not_confirmed';
        } catch (err) {
          deleteError = err?.message || String(err);
        }

        // Compatibilidade: versões que não expõem a mutação de exclusão recebem
        // um caractere invisível. Visualmente a nota fica vazia e o resultado é verificado.
        try {
          if (!WPP?.chat?.setNotes) throw new Error('WPP.chat.setNotes indisponível');
          await WPP.chat.setNotes(resolvedChatId, '\u2060');
          for (let attempt = 0; attempt < 6; attempt += 1) {
            if (attempt > 0) await waitBrowser(300);
            const after = await getNote();
            if (after && !stripInvisible(after.content)) {
              return {
                success: true,
                chatFound: true,
                chatId: resolvedChatId,
                mode: 'blanked-fallback',
                verified: true,
                deleteError,
              };
            }
          }
          return {
            success: false,
            chatFound: true,
            chatId: resolvedChatId,
            reason: 'note_clear_not_confirmed',
            deleteError,
          };
        } catch (fallbackError) {
          return {
            success: false,
            chatFound: true,
            chatId: resolvedChatId,
            reason: fallbackError?.message || String(fallbackError),
            deleteError,
          };
        }
      }, { chatId });
    } catch (err) {
      result = { success: false, chatFound: false, chatId, reason: err?.message || String(err) };
    }

    if (result?.success) return result;
    lastFailure = result;
    if (result?.chatFound) return result;
  }

  return lastFailure || { success: false, reason: 'chat_not_found', chatId: null };
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

    console.log(
      `[RESETARSYS] ${target.clientId}: etiquetas=${labelResult?.success ? 'ok' : `falha(${labelResult?.reason})`} `
      + `nota=${noteResult?.success ? `ok(${noteResult?.mode || 'limpa'})` : `falha(${noteResult?.reason})`}`,
    );
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
    normalizeName,
    targetCandidates,
  },
};
