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
    const getId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '').trim();

    if (typeof labelStore?.getLabelsForModel !== 'function') {
      return { requested: 0, removed: 0, remaining: 0, chatIds: [], error: 'LABEL_STORE_UNAVAILABLE' };
    }

    const foundChats = [];
    const labelsByChat = [];

    for (const chatId of candidates) {
      let chat = null;
      try {
        chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
      } catch (_) {}
      if (!chat) continue;

      const raw = labelStore.getLabelsForModel(chat) || [];
      const attached = Array.isArray(raw) ? raw : Object.values(raw || {});
      const ids = [...new Set(attached.map(getId).filter(Boolean))];
      foundChats.push({ chatId, chat });
      labelsByChat.push({ chatId, ids });
    }

    const requested = labelsByChat.reduce((sum, item) => sum + item.ids.length, 0);
    if (!requested) {
      return { requested: 0, removed: 0, remaining: 0, chatIds: foundChats.map((item) => item.chatId) };
    }

    if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
      for (const item of labelsByChat) {
        if (!item.ids.length) continue;
        await WPP.labels.addOrRemoveLabels(
          [item.chatId],
          item.ids.map((id) => ({ labelId: id, type: 'remove' })),
        );
      }
    } else if (typeof WPP?.lists?.removeChats === 'function') {
      for (const item of labelsByChat) {
        for (const id of item.ids) await WPP.lists.removeChats(id, [item.chatId]);
      }
    } else {
      return {
        requested,
        removed: 0,
        remaining: requested,
        chatIds: foundChats.map((item) => item.chatId),
        error: 'REMOVE_LABEL_API_UNAVAILABLE',
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 900));

    let remaining = 0;
    for (const item of foundChats) {
      const raw = labelStore.getLabelsForModel(item.chat) || [];
      const attached = Array.isArray(raw) ? raw : Object.values(raw || {});
      remaining += [...new Set(attached.map(getId).filter(Boolean))].length;
    }

    return {
      requested,
      removed: Math.max(0, requested - remaining),
      remaining,
      chatIds: foundChats.map((item) => item.chatId),
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
    + `| restantes=${Number(labels.remaining || 0)} | bloqueioHumano=limpo `
    + `| resultado=${ok ? 'OK' : 'PARCIAL'}${labels.error ? ` | erro=${labels.error}` : ''}`,
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
};
