'use strict';

const WppClient = require('../services/wppconnectClient');
const Identity = require('../services/contactIdentity');
const HumanControl = require('../services/humanControlStore');
const { env } = require('../config/env');
const { clearServiceLabelCache } = require('./idempotentServiceLabels');

function normalizeChatId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

function candidateChatIds(clientId) {
  const direct = normalizeChatId(clientId);
  let known = [];
  try {
    known = typeof Identity.getLabelCandidateIds === 'function'
      ? Identity.getLabelCandidateIds(clientId)
      : [];
  } catch (_) {}

  const mapped = [];
  const lidMap = env.lidNumberMap || {};
  const directLid = direct.endsWith('@lid') ? direct : '';
  const mappedPhone = directLid ? normalizePhone(lidMap[directLid]) : '';
  if (mappedPhone) mapped.push(`${mappedPhone}@c.us`);

  return [...new Set([direct, ...known.map(normalizeChatId), ...mapped].filter(Boolean))];
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

    if (typeof WPP?.labels?.getAllLabels !== 'function'
      || typeof WPP?.labels?.addOrRemoveLabels !== 'function') {
      return { requested: 0, removed: 0, remaining: 0, chatIds: [], error: 'LABEL_API_UNAVAILABLE' };
    }

    const resolvedChatIds = [];
    for (const chatId of candidates) {
      try {
        let chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
        if (chat) resolvedChatIds.push(chatId);
      } catch (_) {}
    }

    const uniqueChatIds = [...new Set(resolvedChatIds)];
    if (!uniqueChatIds.length) {
      return {
        requested: 0,
        removed: 0,
        remaining: 0,
        chatIds: [],
        error: `CONTACT_CHAT_NOT_FOUND:${candidates.join(',')}`,
      };
    }

    // Importante: usa o cadastro global de etiquetas, não apenas o cache de
    // vínculos carregado nesta execução. Assim também remove etiquetas que já
    // estavam no contato antes do sistema iniciar.
    const allRaw = await WPP.labels.getAllLabels();
    const allLabels = Array.isArray(allRaw) ? allRaw : Object.values(allRaw || {});
    const allLabelIds = [...new Set(allLabels.map(getId).filter(Boolean))];

    if (!allLabelIds.length) {
      return {
        requested: 0,
        removed: 0,
        remaining: 0,
        chatIds: uniqueChatIds,
        mode: 'no-global-labels',
      };
    }

    const options = allLabelIds.map((labelId) => ({ labelId, type: 'remove' }));
    const errors = [];

    try {
      await WPP.labels.addOrRemoveLabels(uniqueChatIds, options);
    } catch (error) {
      errors.push(`addOrRemoveLabels:${error?.message || error}`);
    }

    await wait(1000);

    // Fallback por lista, útil quando a API principal retorna sem aplicar tudo.
    if (typeof WPP?.lists?.removeChats === 'function') {
      for (const labelId of allLabelIds) {
        try {
          await WPP.lists.removeChats(labelId, uniqueChatIds);
        } catch (error) {
          errors.push(`removeChats:${labelId}:${error?.message || error}`);
        }
      }
    }

    let remaining = null;
    if (typeof labelStore?.getLabelsForModel === 'function') {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        if (attempt > 1) await wait(400);
        remaining = 0;
        for (const chatId of uniqueChatIds) {
          let chat = null;
          try {
            chat = Store?.Chat?.get?.(chatId) || null;
            if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
          } catch (_) {}
          if (!chat) continue;
          const raw = labelStore.getLabelsForModel(chat) || [];
          const attached = Array.isArray(raw) ? raw : Object.values(raw || {});
          remaining += [...new Set(attached.map(getId).filter(Boolean))].length;
        }
        if (remaining === 0) break;
      }
    }

    return {
      requested: allLabelIds.length,
      removed: remaining === null ? null : Math.max(0, allLabelIds.length - remaining),
      remaining,
      chatIds: uniqueChatIds,
      mode: 'global-label-registry',
      error: remaining === 0 ? null : (errors.join(' | ') || 'LABEL_REMOVAL_NOT_CONFIRMED'),
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
      remaining: null,
      chatIds: [],
      error: error?.message || String(error),
    };
  }

  try { HumanControl.clearBlock(clientId); } catch (_) {}
  try { clearServiceLabelCache(clientId); } catch (_) {}

  const labelsConfirmed = labels.remaining === 0 && !labels.error;
  const ok = note.cleared && labelsConfirmed;
  console.log(
    `[RESETARSYS] contato limpo | cliente=${clientId} | ids=${candidates.join(',') || '-'} `
    + `| chatsEncontrados=${(labels.chatIds || []).join(',') || '-'} `
    + `| nota=${note.cleared ? `apagada:${note.chatId}` : 'não_confirmada'} `
    + `| etiquetasGlobais=${Number(labels.requested || 0)} `
    + `| restantes=${labels.remaining === null ? 'não_confirmado' : Number(labels.remaining)} `
    + `| modo=${labels.mode || '-'} | bloqueioHumano=limpo `
    + `| resultado=${ok ? 'OK' : 'PARCIAL'}`
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
};
