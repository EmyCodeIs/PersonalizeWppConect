'use strict';

const WppClient = require('../services/wppconnectClient');
const Identity = require('../services/contactIdentity');
const HumanControl = require('../services/humanControlStore');
const { clearServiceLabelCache } = require('./idempotentServiceLabels');

function normalizeChatId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function mappedChatIds(clientId) {
  const direct = normalizeChatId(clientId);
  const entries = String(process.env.LID_NUMBER_MAP || '')
    .split(/[;,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const mapped = [];

  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 1) continue;
    const lid = normalizeChatId(entry.slice(0, separatorIndex));
    const number = String(entry.slice(separatorIndex + 1) || '').replace(/\D/g, '');
    if (!lid || !number) continue;
    const cUs = normalizeChatId(number);

    if (direct === lid) mapped.push(cUs);
    if (direct === cUs) mapped.push(lid);
  }

  return [...new Set(mapped.filter(Boolean))];
}

function candidateChatIds(clientId) {
  const direct = normalizeChatId(clientId);
  let known = [];
  try {
    known = typeof Identity.getLabelCandidateIds === 'function'
      ? Identity.getLabelCandidateIds(clientId)
      : [];
  } catch (_) {}

  return [...new Set([
    direct,
    ...known.map(normalizeChatId),
    ...mappedChatIds(clientId),
  ].filter(Boolean))];
}

async function clearNote(channel, candidates) {
  const attempted = [];
  for (const chatId of candidates) {
    attempted.push(chatId);
    try {
      const result = await channel?.setContactNote?.(chatId, '');
      if (result !== false && result !== null && result !== undefined) {
        return { cleared: true, chatId, attempted };
      }
    } catch (_) {}
  }
  return { cleared: false, chatId: null, attempted };
}

async function clearLabels(channel, candidates) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { requested: 0, removed: 0, remaining: 0, chatIds: [], error: 'LABEL_PAGE_UNAVAILABLE' };
  }

  return client.page.evaluate(async ({ candidates }) => {
    const WPP = window.WPP || null;
    const Store = window.Store || null;
    const labelStore = Store?.Label || Store?.Labels || null;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const getId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '').trim();

    if (typeof labelStore?.getLabelsForModel !== 'function') {
      return { requested: 0, removed: 0, remaining: 0, chatIds: [], error: 'LABEL_STORE_UNAVAILABLE' };
    }

    const resolveChat = async (chatId) => {
      let chat = null;
      try {
        chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
      } catch (_) {}
      return chat;
    };

    const readAttachedIds = async (chatId) => {
      const chat = await resolveChat(chatId);
      if (!chat) return { chatFound: false, ids: [] };
      const raw = labelStore.getLabelsForModel(chat) || [];
      const attached = Array.isArray(raw) ? raw : Object.values(raw || {});
      return {
        chatFound: true,
        ids: [...new Set(attached.map(getId).filter(Boolean))],
      };
    };

    const labelsByChat = [];
    for (const chatId of candidates) {
      const before = await readAttachedIds(chatId);
      if (!before.chatFound) continue;
      labelsByChat.push({ chatId, ids: before.ids });
    }

    const requested = labelsByChat.reduce((sum, item) => sum + item.ids.length, 0);
    if (!requested) {
      return {
        requested: 0,
        removed: 0,
        remaining: 0,
        chatIds: labelsByChat.map((item) => item.chatId),
        mode: 'already-clean',
      };
    }

    const errors = [];
    const modes = [];

    for (const item of labelsByChat) {
      if (!item.ids.length) continue;

      let submitted = false;
      if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
        try {
          await WPP.labels.addOrRemoveLabels(
            item.chatId,
            item.ids.map((id) => ({ labelId: String(id), type: 'remove' })),
          );
          submitted = true;
          modes.push('labels.addOrRemoveLabels');
        } catch (error) {
          errors.push(`addOrRemoveLabels:${item.chatId}:${error?.message || error}`);
        }
      }

      await wait(500);
      const after = await readAttachedIds(item.chatId);
      const remainingIds = after.ids.filter((id) => item.ids.includes(id));

      if (remainingIds.length && typeof WPP?.lists?.removeChats === 'function') {
        try {
          for (const id of remainingIds) {
            await WPP.lists.removeChats(String(id), [item.chatId]);
          }
          submitted = true;
          modes.push('lists.removeChats');
        } catch (error) {
          errors.push(`removeChats:${item.chatId}:${error?.message || error}`);
        }
      }

      if (!submitted) errors.push(`REMOVE_LABEL_API_UNAVAILABLE:${item.chatId}`);
    }

    let remaining = requested;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      if (attempt > 1) await wait(350);
      remaining = 0;
      for (const item of labelsByChat) {
        const after = await readAttachedIds(item.chatId);
        remaining += after.ids.filter((id) => item.ids.includes(id)).length;
      }
      if (remaining === 0) break;
    }

    return {
      requested,
      removed: Math.max(0, requested - remaining),
      remaining,
      chatIds: labelsByChat.map((item) => item.chatId),
      mode: [...new Set(modes)].join('+') || null,
      error: remaining > 0 ? (errors.join(' | ') || 'LABEL_REMOVAL_NOT_CONFIRMED') : null,
    };
  }, { candidates });
}

async function clearContactForSystemReset(channel, clientId) {
  const candidates = candidateChatIds(clientId);
  const note = await clearNote(channel, candidates);
  let labels;

  try {
    labels = await clearLabels(channel, candidates);
  } catch (error) {
    labels = {
      requested: 0,
      removed: 0,
      remaining: 0,
      chatIds: [],
      error: error?.message || String(error),
    };
  }

  try { HumanControl.clearBlock(clientId); } catch (_) {}
  try { clearServiceLabelCache(clientId); } catch (_) {}

  const ok = note.cleared && !labels.error && Number(labels.remaining || 0) === 0;
  console.log(
    `[RESETARSYS] contato limpo | cliente=${clientId} | ids=${candidates.join(',') || '-'} `
    + `| nota=${note.cleared ? `apagada:${note.chatId}` : 'não_confirmada'} `
    + `| etiquetas=${Number(labels.removed || 0)}/${Number(labels.requested || 0)} `
    + `| restantes=${Number(labels.remaining || 0)} | modo=${labels.mode || '-'} `
    + `| bloqueioHumano=limpo | resultado=${ok ? 'OK' : 'PARCIAL'}`
    + `${labels.error ? ` | erro=${labels.error}` : ''}`,
  );

  return { ok, candidates, note, labels };
}

function installResetCleanup(channel) {
  if (!channel || typeof channel.sendText !== 'function' || channel.__resetCleanupInstalled) return channel;
  const originalSendText = channel.sendText.bind(channel);

  channel.sendText = async (clientId, text, options = {}) => {
    const message = String(text || '');
    if (message.startsWith('Sistema resetado para teste.')) {
      await clearContactForSystemReset(channel, clientId);
    }
    return originalSendText(clientId, text, options);
  };

  channel.__resetCleanupInstalled = true;
  return channel;
}

const originalCreateWppChannel = WppClient.createWppChannel;
WppClient.createWppChannel = async function createWppChannelWithReliableReset(options = {}) {
  const channel = await originalCreateWppChannel(options);
  return installResetCleanup(channel);
};

module.exports = {
  candidateChatIds,
  clearContactForSystemReset,
  installResetCleanup,
  mappedChatIds,
};
