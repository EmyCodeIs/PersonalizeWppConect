'use strict';

const SellerHandoff = require('./sellerHandoff');
const Store = require('../services/leadStore');
const Identity = require('../services/contactIdentity');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function serializedId(value) {
  return String(
    value?._serialized
    || value?.id?._serialized
    || value?.id
    || value?.chatId
    || value
    || '',
  ).trim();
}

function extractLabelUpdateChatId(data = {}) {
  const candidates = [
    data?.chat?.id?._serialized,
    data?.chat?.id,
    data?.chat?.chatId,
    data?.chatId,
    typeof data?.chat === 'string' ? data.chat : '',
  ];
  return candidates.map(serializedId).find(Boolean) || '';
}

function labelNamesFromUpdate(data = {}) {
  const labels = Array.isArray(data?.labels) ? data.labels : Object.values(data?.labels || {});
  return labels
    .map((label) => String(label?.name || label?.label || '').trim())
    .filter(Boolean);
}

function existingSessionFor(clientId) {
  const candidates = new Set();
  try {
    candidates.add(Store.normalizeClientId(clientId));
    for (const alias of Identity.getLabelCandidateIds(clientId)) {
      candidates.add(Store.normalizeClientId(alias));
    }
  } catch (_) {}

  return Store.listSessions().find((session) => {
    const id = session?.chatId || session?.clientId || session?.id;
    return candidates.has(Store.normalizeClientId(id));
  }) || null;
}

function persistSellerStatus(clientId, payload = {}) {
  const session = existingSessionFor(clientId);
  if (!session) return false;

  const data = session.dados || (session.dados = {});
  const previous = data.sellerHandoff || {};
  data.sellerHandoff = {
    ...previous,
    status: payload.status || previous.status || null,
    seller: payload.seller ?? previous.seller ?? null,
    labelName: payload.labelName ?? previous.labelName ?? null,
    assignedAt: payload.assignedAt ?? previous.assignedAt ?? null,
    releasedAt: payload.releasedAt ?? previous.releasedAt ?? null,
    lastLabelEventAt: new Date().toISOString(),
  };
  Store.saveSession(session);
  return true;
}

function createSellerLabelUpdateHandler(options = {}) {
  const getChannel = options.getChannel || (() => null);
  const clearBuffer = options.clearBuffer || (() => {});
  const delayMs = Math.max(0, Number(options.delayMs ?? 500));
  const seen = new Map();

  return async function handleSellerLabelUpdate(payload = {}) {
    const data = payload?.data || payload || {};
    const channel = payload?.channel || getChannel();
    const chatId = extractLabelUpdateChatId(data);
    const type = String(data?.type || 'update').trim().toLowerCase();
    const names = labelNamesFromUpdate(data);

    if (!chatId) {
      console.warn(`[ETIQUETAS][EVENTO] atualização sem chat identificável | tipo=${type} | etiquetas=${names.join(', ') || '-'}`);
      return { handled: false, reason: 'CHAT_ID_UNAVAILABLE' };
    }

    if (channel?.__isInternalLabelOperation?.(chatId)) {
      console.log(`[ETIQUETAS][EVENTO] alteração interna ignorada | cliente=${chatId} | tipo=${type} | etiquetas=${names.join(', ') || '-'}`);
      return { handled: false, reason: 'INTERNAL_OPERATION', chatId };
    }

    if (delayMs) await wait(delayMs);

    const guard = await SellerHandoff.getAutomationBlock(channel, chatId);
    if (guard?.blocked && guard.reason === 'seller_label') {
      const key = `${chatId}:assigned:${guard.seller || guard.labelName || '-'}`;
      const now = Date.now();
      const duplicate = Number(seen.get(key) || 0) > (now - 15000);
      seen.set(key, now);

      persistSellerStatus(chatId, {
        status: 'assigned',
        seller: guard.seller || null,
        labelName: guard.labelName || null,
        assignedAt: new Date().toISOString(),
        releasedAt: null,
      });
      clearBuffer(chatId);

      if (!duplicate) {
        const session = existingSessionFor(chatId);
        const phase = session?.completed || session?.dados?.botDone ? 'concluído' : 'em_andamento';
        console.log(
          `[HANDOFF][VENDEDOR] cliente assumido | cliente=${chatId} | vendedor=${guard.seller || '-'} `
          + `| etiqueta="${guard.labelName || '-'}" | préAtendimento=${phase} | evento=${type}`,
        );
      }
      return { handled: true, assigned: true, chatId, guard };
    }

    if (guard?.source === 'seller_label_removed') {
      persistSellerStatus(chatId, {
        status: 'released',
        releasedAt: new Date().toISOString(),
      });
      console.log(`[HANDOFF][VENDEDOR] etiqueta removida; automação liberada | cliente=${chatId}`);
      return { handled: true, assigned: false, released: true, chatId, guard };
    }

    console.log(
      `[ETIQUETAS][EVENTO] alteração externa sem vendedor ativo | cliente=${chatId} `
      + `| tipo=${type} | etiquetas=${names.join(', ') || '-'}`,
    );
    return { handled: true, assigned: false, chatId, guard };
  };
}

module.exports = {
  createSellerLabelUpdateHandler,
  existingSessionFor,
  extractLabelUpdateChatId,
  labelNamesFromUpdate,
  persistSellerStatus,
  serializedId,
};
