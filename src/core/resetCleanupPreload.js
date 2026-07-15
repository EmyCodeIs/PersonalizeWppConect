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

function resetCommandFromPayload(payload = {}) {
  const text = String(
    payload?.text
    || payload?.raw?.body
    || payload?.raw?.text
    || payload?.raw?.caption
    || ''
  ).trim();
  return text.split(/\r?\n/)[0].trim().toLowerCase() === '/resetarsys';
}

async function clearNote(channel, candidates) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return {
      cleared: false,
      found: 0,
      clearedChatIds: [],
      attempted: [...candidates],
      results: [],
      error: 'NOTE_PAGE_UNAVAILABLE',
    };
  }

  try {
    return await client.page.evaluate(async ({ candidates }) => {
      const WPP = window.WPP || null;
      const hasGetApi = typeof WPP?.chat?.getNotes === 'function'
        || typeof WPP?.contact?.getNotes === 'function';
      const invisibleBlank = '\u200B';
      const visibleContent = (value) => String(value || '')
        .replace(/[\s\u200B\u200C\u200D\u2060\uFEFF]/g, '');
      const noteContent = (note) => note?.content
        ?? note?.attributes?.content
        ?? note?._value?.content
        ?? '';

      if (!hasGetApi) {
        return {
          cleared: false,
          found: 0,
          clearedChatIds: [],
          attempted: [...candidates],
          results: [],
          error: 'NOTE_GET_API_UNAVAILABLE',
        };
      }

      const getNote = async (chatId) => {
        if (typeof WPP?.chat?.getNotes === 'function') return WPP.chat.getNotes(chatId);
        return WPP.contact.getNotes(chatId);
      };

      const setNote = async (chatId, content) => {
        if (typeof WPP?.chat?.setNotes === 'function') return WPP.chat.setNotes(chatId, content);
        if (typeof WPP?.contact?.setNotes === 'function') return WPP.contact.setNotes(chatId, content);
        throw new Error('NOTE_SET_API_UNAVAILABLE');
      };

      const deleteCandidates = [
        [WPP?.chat, 'deleteNotes'],
        [WPP?.chat, 'removeNotes'],
        [WPP?.chat, 'clearNotes'],
        [WPP?.contact, 'deleteNotes'],
        [WPP?.contact, 'removeNotes'],
        [WPP?.contact, 'clearNotes'],
      ];

      const results = [];
      for (const chatId of candidates) {
        let before = null;
        try {
          before = await getNote(chatId);
        } catch (error) {
          results.push({
            chatId,
            found: false,
            cleared: false,
            mode: 'read-error',
            error: String(error?.message || error),
          });
          continue;
        }

        if (!before) {
          results.push({ chatId, found: false, cleared: true, mode: 'sem-nota' });
          continue;
        }

        if (!visibleContent(noteContent(before))) {
          results.push({ chatId, found: true, cleared: true, mode: 'já-vazia' });
          continue;
        }

        let deleted = false;
        let deleteMode = null;
        for (const [scope, method] of deleteCandidates) {
          if (typeof scope?.[method] !== 'function') continue;
          try {
            await scope[method](chatId);
            const afterDelete = await getNote(chatId).catch(() => null);
            if (!afterDelete || !visibleContent(noteContent(afterDelete))) {
              deleted = true;
              deleteMode = method;
              break;
            }
          } catch (_) {}
        }

        if (deleted) {
          results.push({ chatId, found: true, cleared: true, mode: deleteMode });
          continue;
        }

        // O WA-JS rejeita conteúdo vazio em setNotes. Quando a versão carregada
        // não expõe uma função de remoção, gravamos um caractere invisível e
        // verificamos se não restou nenhum conteúdo visível para o atendente.
        try {
          await setNote(chatId, invisibleBlank);
          const afterBlank = await getNote(chatId).catch(() => null);
          const cleared = !afterBlank || !visibleContent(noteContent(afterBlank));
          results.push({
            chatId,
            found: true,
            cleared,
            mode: 'vazio-invisível',
            error: cleared ? null : 'NOTE_CONTENT_REMAINED',
          });
        } catch (error) {
          results.push({
            chatId,
            found: true,
            cleared: false,
            mode: 'write-error',
            error: String(error?.message || error),
          });
        }
      }

      const readableResults = results.filter((item) => item.mode !== 'read-error');
      const foundResults = readableResults.filter((item) => item.found);
      const failures = readableResults.filter((item) => !item.cleared);
      const noReadableAlias = readableResults.length === 0;
      const errors = failures.length
        ? failures
        : (noReadableAlias ? results.filter((item) => item.error) : []);

      return {
        cleared: !noReadableAlias && failures.length === 0,
        found: foundResults.length,
        clearedChatIds: foundResults.filter((item) => item.cleared).map((item) => item.chatId),
        attempted: [...candidates],
        results,
        error: errors.length ? errors.map((item) => `${item.chatId}:${item.error || item.mode}`).join(' | ') : null,
      };
    }, { candidates });
  } catch (error) {
    return {
      cleared: false,
      found: 0,
      clearedChatIds: [],
      attempted: [...candidates],
      results: [],
      error: String(error?.message || error),
    };
  }
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

async function clearContactForSystemReset(channel, clientId, preservedCandidates = null) {
  const candidates = Array.isArray(preservedCandidates) && preservedCandidates.length
    ? [...new Set(preservedCandidates.map(normalizeChatId).filter(Boolean))]
    : candidateChatIds(clientId);
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
    + `| notasEncontradas=${Number(note.found || 0)} `
    + `| notasLimpas=${(note.clearedChatIds || []).join(',') || 'nenhuma/ausente'} `
    + `| nota=${note.cleared ? 'apagada' : 'não_confirmada'} `
    + `| etiquetasGlobais=${Number(labels.requested || 0)} `
    + `| restantes=${labels.remaining === null ? 'não_confirmado' : Number(labels.remaining)} `
    + `| modo=${labels.mode || '-'} | bloqueioHumano=limpo `
    + `| resultado=${ok ? 'OK' : 'PARCIAL'}`
    + `${note.error ? ` | erroNota=${note.error}` : ''}`
    + `${labels.error ? ` | erro=${labels.error}` : ''}`,
  );

  return { ok, candidates, note, labels };
}

function installResetCleanup(channel, pendingResetCandidates = new Map()) {
  if (!channel || typeof channel.sendText !== 'function' || channel.__resetCleanupInstalled) return channel;
  const originalSendText = channel.sendText.bind(channel);

  channel.sendText = async (clientId, text, options = {}) => {
    const message = String(text || '');
    if (message.startsWith('Sistema resetado para teste.')) {
      const key = normalizeChatId(clientId);
      const preserved = pendingResetCandidates.get(key) || null;
      await clearContactForSystemReset(channel, clientId, preserved);
      for (const candidate of preserved || [key]) pendingResetCandidates.delete(normalizeChatId(candidate));
    }
    return originalSendText(clientId, text, options);
  };

  channel.__resetCleanupInstalled = true;
  return channel;
}

const originalCreateWppChannel = WppClient.createWppChannel;
WppClient.createWppChannel = async function createWppChannelWithReliableReset(options = {}) {
  const pendingResetCandidates = new Map();
  const originalOnMessage = options.onMessage;

  const onMessage = async (payload = {}) => {
    if (resetCommandFromPayload(payload)) {
      const clientId = normalizeChatId(payload.from || payload?.raw?.from || payload?.raw?.chatId || '');
      if (clientId) {
        const preserved = candidateChatIds(clientId);
        for (const candidate of preserved) pendingResetCandidates.set(normalizeChatId(candidate), preserved);
        pendingResetCandidates.set(clientId, preserved);
        console.log(`[RESETARSYS] IDs preservados antes da limpeza local: ${preserved.join(',') || clientId}`);
      }
    }

    if (typeof originalOnMessage === 'function') return originalOnMessage(payload);
    return undefined;
  };

  const channel = await originalCreateWppChannel({ ...options, onMessage });
  return installResetCleanup(channel, pendingResetCandidates);
};

module.exports = {
  candidateChatIds,
  clearContactForSystemReset,
  installResetCleanup,
  resetCommandFromPayload,
};