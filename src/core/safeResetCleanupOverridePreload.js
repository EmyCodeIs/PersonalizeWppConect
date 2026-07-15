'use strict';

const WppClient = require('../services/wppconnectClient');
const Identity = require('../services/contactIdentity');
const HumanControl = require('../services/humanControlStore');
const { env } = require('../config/env');
const { clearServiceLabelCache } = require('./idempotentServiceLabels');

const RESET_RESPONSE_PREFIX = 'Sistema resetado para teste.';
const INVISIBLE_PREFIX = '\u200B';

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChatId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function candidateChatIds(clientId) {
  const direct = normalizeChatId(clientId);
  let known = [];
  try {
    known = typeof Identity.getLabelCandidateIds === 'function'
      ? Identity.getLabelCandidateIds(clientId)
      : [];
  } catch (_) {}
  return [...new Set([direct, ...known.map(normalizeChatId)].filter(Boolean))];
}

function managedLabelNames() {
  return [...new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    env.awaitingQuoteLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
    ...Object.keys(env.sellerLabelRules || {}),
  ].map(normalizeName).filter(Boolean))];
}

function selectManagedLabelIds(labels = [], names = managedLabelNames()) {
  const wanted = new Set((names || []).map(normalizeName).filter(Boolean));
  return [...new Set((labels || [])
    .filter((item) => wanted.has(normalizeName(item?.name || item?.label)))
    .map((item) => String(item?.id?._serialized || item?.id || item?.labelId || '').trim())
    .filter(Boolean))];
}

async function clearNote(channel, candidates) {
  const client = channel?.client;
  if (!client?.page?.evaluate) return { cleared: false, error: 'NOTE_PAGE_UNAVAILABLE' };

  try {
    return await client.page.evaluate(async ({ candidates }) => {
      const WPP = window.WPP || null;
      const invisibleBlank = '\u200B';
      const visible = (value) => String(value || '').replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]/g, '');
      const noteContent = (note) => note?.content ?? note?.attributes?.content ?? note?._value?.content ?? '';
      const getNote = async (chatId) => {
        if (typeof WPP?.chat?.getNotes === 'function') return WPP.chat.getNotes(chatId);
        if (typeof WPP?.contact?.getNotes === 'function') return WPP.contact.getNotes(chatId);
        return null;
      };
      const setNote = async (chatId, content) => {
        if (typeof WPP?.chat?.setNotes === 'function') return WPP.chat.setNotes(chatId, content);
        if (typeof WPP?.contact?.setNotes === 'function') return WPP.contact.setNotes(chatId, content);
        throw new Error('NOTE_SET_API_UNAVAILABLE');
      };
      const deleteMethods = [
        [WPP?.chat, 'deleteNotes'], [WPP?.chat, 'removeNotes'], [WPP?.chat, 'clearNotes'],
        [WPP?.contact, 'deleteNotes'], [WPP?.contact, 'removeNotes'], [WPP?.contact, 'clearNotes'],
      ];

      let found = 0;
      let failures = 0;
      for (const chatId of candidates) {
        const before = await getNote(chatId).catch(() => null);
        if (!before || !visible(noteContent(before))) continue;
        found += 1;
        let cleared = false;

        for (const [scope, method] of deleteMethods) {
          if (typeof scope?.[method] !== 'function') continue;
          try {
            await scope[method](chatId);
            const after = await getNote(chatId).catch(() => null);
            if (!after || !visible(noteContent(after))) {
              cleared = true;
              break;
            }
          } catch (_) {}
        }

        if (!cleared) {
          try {
            await setNote(chatId, invisibleBlank);
            const after = await getNote(chatId).catch(() => null);
            cleared = !after || !visible(noteContent(after));
          } catch (_) {}
        }

        if (!cleared) failures += 1;
      }

      return { cleared: failures === 0, found, failures };
    }, { candidates });
  } catch (error) {
    return { cleared: false, error: error?.message || String(error) };
  }
}

async function clearManagedLabels(channel, candidates) {
  const client = channel?.client;
  const names = managedLabelNames();
  if (!client?.page?.evaluate) {
    return { removed: 0, remaining: null, preserved: null, error: 'LABEL_PAGE_UNAVAILABLE' };
  }

  try {
    return await client.page.evaluate(async ({ candidates, names }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const wanted = new Set((names || []).map(normalize).filter(Boolean));
      const getId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '').trim();
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      if (typeof WPP?.labels?.getAllLabels !== 'function') {
        return { removed: 0, remaining: null, preserved: null, error: 'LABEL_LIST_API_UNAVAILABLE' };
      }

      const allRaw = await WPP.labels.getAllLabels();
      const allLabels = Array.isArray(allRaw) ? allRaw : Object.values(allRaw || {});
      const managedIds = [...new Set(allLabels
        .filter((item) => wanted.has(normalize(item?.name || item?.label)))
        .map(getId)
        .filter(Boolean))];

      const resolvedChats = [];
      for (const chatId of candidates) {
        try {
          let chat = Store?.Chat?.get?.(chatId) || null;
          if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
          if (chat) resolvedChats.push({ chatId, chat });
        } catch (_) {}
      }

      if (!resolvedChats.length || !managedIds.length) {
        return { removed: 0, remaining: 0, preserved: null, chatIds: resolvedChats.map((item) => item.chatId) };
      }

      let managedBefore = 0;
      let manualBefore = 0;
      if (typeof labelStore?.getLabelsForModel === 'function') {
        for (const { chat } of resolvedChats) {
          const attachedRaw = labelStore.getLabelsForModel(chat) || [];
          const attached = Array.isArray(attachedRaw) ? attachedRaw : Object.values(attachedRaw || {});
          for (const entry of attached) {
            if (managedIds.includes(getId(entry))) managedBefore += 1;
            else manualBefore += 1;
          }
        }
      }

      const chatIds = resolvedChats.map((item) => item.chatId);
      const operations = managedIds.map((labelId) => ({ labelId, type: 'remove' }));
      const errors = [];

      if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
        try { await WPP.labels.addOrRemoveLabels(chatIds, operations); }
        catch (error) { errors.push(`addOrRemoveLabels:${error?.message || error}`); }
      } else if (typeof WPP?.lists?.removeChats === 'function') {
        for (const labelId of managedIds) {
          try { await WPP.lists.removeChats(labelId, chatIds); }
          catch (error) { errors.push(`removeChats:${labelId}:${error?.message || error}`); }
        }
      } else {
        return { removed: 0, remaining: managedBefore, preserved: manualBefore, error: 'LABEL_REMOVE_API_UNAVAILABLE' };
      }

      await wait(700);
      let remaining = null;
      let preserved = null;
      if (typeof labelStore?.getLabelsForModel === 'function') {
        remaining = 0;
        preserved = 0;
        for (const { chat } of resolvedChats) {
          const attachedRaw = labelStore.getLabelsForModel(chat) || [];
          const attached = Array.isArray(attachedRaw) ? attachedRaw : Object.values(attachedRaw || {});
          for (const entry of attached) {
            if (managedIds.includes(getId(entry))) remaining += 1;
            else preserved += 1;
          }
        }
      }

      return {
        requested: managedIds.length,
        removed: remaining === null ? null : Math.max(0, managedBefore - remaining),
        remaining,
        preserved,
        chatIds,
        error: errors.length ? errors.join(' | ') : null,
      };
    }, { candidates, names });
  } catch (error) {
    return { removed: 0, remaining: null, preserved: null, error: error?.message || String(error) };
  }
}

async function safeCleanup(channel, clientId) {
  const candidates = candidateChatIds(clientId);
  const note = await clearNote(channel, candidates);
  const labels = await clearManagedLabels(channel, candidates);
  try { HumanControl.clearBlock(clientId); } catch (_) {}
  try { clearServiceLabelCache(clientId); } catch (_) {}

  console.log(
    `[RESETARSYS][SEGURO] cliente=${clientId} | nota=${note.cleared ? 'limpa' : 'não_confirmada'} `
    + `| etiquetasGerenciadasRemovidas=${labels.removed ?? 'não_confirmado'} `
    + `| gerenciadasRestantes=${labels.remaining ?? 'não_confirmado'} `
    + `| etiquetasManuaisPreservadas=${labels.preserved ?? 'não_confirmado'} `
    + `| bloqueioHumano=limpo${labels.error ? ` | erro=${labels.error}` : ''}`,
  );

  return { candidates, note, labels };
}

function installSafeResetCleanupOverride() {
  if (WppClient.__safeResetCleanupOverrideInstalled) return;
  const originalCreateWppChannel = WppClient.createWppChannel;

  WppClient.createWppChannel = async function createWppChannelWithSafeResetCleanup(options = {}) {
    const channel = await originalCreateWppChannel(options);
    if (!channel || typeof channel.sendText !== 'function' || channel.__safeResetCleanupOverrideInstalled) return channel;

    const originalSendText = channel.sendText.bind(channel);
    channel.sendText = async (clientId, text, sendOptions = {}) => {
      const message = String(text || '');
      if (!message.startsWith(RESET_RESPONSE_PREFIX)) {
        return originalSendText(clientId, text, sendOptions);
      }

      await safeCleanup(channel, clientId);

      // O wrapper antigo reconhece apenas mensagens iniciadas exatamente pelo
      // prefixo. O caractere invisível impede que ele remova todas as etiquetas,
      // mantendo o texto visualmente idêntico para o usuário.
      return originalSendText(clientId, `${INVISIBLE_PREFIX}${message}`, sendOptions);
    };

    channel.__safeResetCleanupOverrideInstalled = true;
    return channel;
  };

  WppClient.__safeResetCleanupOverrideInstalled = true;
}

installSafeResetCleanupOverride();

module.exports = {
  RESET_RESPONSE_PREFIX,
  candidateChatIds,
  clearManagedLabels,
  installSafeResetCleanupOverride,
  managedLabelNames,
  normalizeName,
  safeCleanup,
  selectManagedLabelIds,
};
