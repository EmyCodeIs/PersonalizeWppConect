'use strict';

const SellerHandoff = require('./sellerHandoff');
const HumanControl = require('../services/humanControlStore');
const Store = require('../services/leadStore');
const Identity = require('../services/contactIdentity');
const Cancellation = require('./automationCancellation');
const { env } = require('../config/env');

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

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function operationalLabelNames() {
  return new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ].map(normalizeName).filter(Boolean));
}

function externalEventLabelNames(names = []) {
  const managed = operationalLabelNames();
  return names.filter((name) => !managed.has(normalizeName(name)));
}

function sellerFromEventNames(names = []) {
  const byNormalizedName = new Map(
    Object.keys(env.sellerLabelRules || {}).map((name) => [normalizeName(name), name]),
  );
  for (const labelName of names) {
    const seller = byNormalizedName.get(normalizeName(labelName));
    if (seller) return { seller, labelName };
  }
  return null;
}

function firstManualLabelName(names = []) {
  return names.map((name) => String(name || '').trim()).find(Boolean) || null;
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
  const cancelQueued = options.cancelQueued || (() => {});
  const stopAutomation = (clientId, reason) => {
    clearBuffer(clientId);
    cancelQueued(clientId, reason);
    return Cancellation.cancelContact(clientId, reason);
  };
  const delayMs = Math.max(0, Number(options.delayMs ?? 500));
  const seen = new Map();

  return async function handleSellerLabelUpdate(payload = {}) {
    const data = payload?.data || payload || {};
    const channel = payload?.channel || getChannel();
    const chatId = extractLabelUpdateChatId(data);
    const type = String(data?.type || 'update').trim().toLowerCase();
    const names = labelNamesFromUpdate(data);
    const externalNames = externalEventLabelNames(names);

    if (!chatId) {
      console.warn(`[ETIQUETAS][EVENTO] atualização sem chat identificável | tipo=${type} | etiquetas=${names.join(', ') || '-'}`);
      return { handled: false, reason: 'CHAT_ID_UNAVAILABLE' };
    }

    if (channel?.__isInternalLabelOperation?.(chatId)) {
      console.log(`[ETIQUETAS][EVENTO] alteração interna ignorada | cliente=${chatId} | tipo=${type} | etiquetas=${names.join(', ') || '-'}`);
      return { handled: false, reason: 'INTERNAL_OPERATION', chatId };
    }

    const sellerFromEvent = type === 'add' ? sellerFromEventNames(externalNames) : null;
    if (sellerFromEvent) {
      const key = `${chatId}:assigned:${sellerFromEvent.seller}`;
      const now = Date.now();
      const duplicate = Number(seen.get(key) || 0) > (now - 15000);
      seen.set(key, now);

      HumanControl.setBlock(chatId, {
        reason: 'seller_label',
        source: 'seller_label_event',
        seller: sellerFromEvent.seller,
        labelName: sellerFromEvent.labelName,
        persistent: true,
      });

      persistSellerStatus(chatId, {
        status: 'assigned',
        seller: sellerFromEvent.seller,
        labelName: sellerFromEvent.labelName,
        assignedAt: new Date().toISOString(),
        releasedAt: null,
      });
      stopAutomation(chatId, 'seller_label');

      if (!duplicate) {
        const session = existingSessionFor(chatId);
        const phase = session?.completed || session?.dados?.botDone ? 'concluído' : 'em_andamento';
        console.log(
          `[HANDOFF][VENDEDOR] cliente assumido pelo evento real | cliente=${chatId} `
          + `| vendedor=${sellerFromEvent.seller} | etiqueta="${sellerFromEvent.labelName}" `
          + `| préAtendimento=${phase} | evento=${type}`,
        );
      }

      return {
        handled: true,
        assigned: true,
        chatId,
        guard: {
          blocked: true,
          reason: 'seller_label',
          seller: sellerFromEvent.seller,
          labelName: sellerFromEvent.labelName,
          source: 'seller_label_event',
        },
      };
    }

    const manualLabelName = type === 'add' ? firstManualLabelName(externalNames) : null;
    if (manualLabelName) {
      const key = `${chatId}:manual:${normalizeName(manualLabelName)}`;
      const now = Date.now();
      const duplicate = Number(seen.get(key) || 0) > (now - 15000);
      seen.set(key, now);

      HumanControl.setBlock(chatId, {
        reason: 'manual_label',
        source: 'manual_label_event',
        seller: null,
        labelName: manualLabelName,
        persistent: true,
        blockedHours: env.humanBlockHours,
      });

      persistSellerStatus(chatId, {
        status: 'assigned',
        seller: null,
        labelName: manualLabelName,
        assignedAt: new Date().toISOString(),
        releasedAt: null,
      });
      stopAutomation(chatId, 'manual_label');

      if (!duplicate) {
        const session = existingSessionFor(chatId);
        const phase = session?.completed || session?.dados?.botDone ? 'concluído' : 'em_andamento';
        console.log(
          `[HANDOFF][MANUAL] cliente assumido por etiqueta manual | cliente=${chatId} `
          + `| etiqueta="${manualLabelName}" | préAtendimento=${phase} | evento=${type}`,
        );
      }

      return {
        handled: true,
        assigned: true,
        chatId,
        guard: {
          blocked: true,
          reason: 'manual_label',
          seller: null,
          labelName: manualLabelName,
          source: 'manual_label_event',
        },
      };
    }

    if (type === 'remove') {
      const current = HumanControl.getBlock(chatId);
      if (current?.blocked) {
        stopAutomation(chatId, current.control?.reason || 'human_handoff');
        persistSellerStatus(chatId, {
          status: 'assigned',
          seller: current.control?.seller || null,
          labelName: current.control?.labelName || null,
          releasedAt: null,
        });
        console.log(
          `[HANDOFF] etiqueta removida; bloqueio permanente mantido | cliente=${chatId} `
          + `| motivo=${current.control?.reason || 'human_handoff'}`,
        );
        return {
          handled: true,
          assigned: true,
          retained: true,
          released: false,
          chatId,
          guard: {
            blocked: true,
            reason: current.control?.reason || 'human_handoff',
            seller: current.control?.seller || null,
            labelName: current.control?.labelName || null,
            source: current.control?.source || 'human_control',
          },
        };
      }
    }

    if (delayMs) await wait(delayMs);

    const guard = await SellerHandoff.getAutomationBlock(channel, chatId);
    if (guard?.blocked && !guard.temporary) {
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
      stopAutomation(chatId, guard.reason || 'human_handoff');

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
  normalizeName,
  operationalLabelNames,
  externalEventLabelNames,
  sellerFromEventNames,
  persistSellerStatus,
  serializedId,
};
