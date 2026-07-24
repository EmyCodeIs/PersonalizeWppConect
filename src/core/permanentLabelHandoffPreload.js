'use strict';

const WppClient = require('../services/wppconnectClient');
const SellerHandoff = require('./sellerHandoff');
const HumanControl = require('../services/humanControlStore');
const Identity = require('../services/contactIdentity');
const { BufferManager } = require('./bufferManager');
const { ChatTaskQueue } = require('./chatTaskQueue');
const Cancellation = require('./automationCancellation');
const { resolveSellerLabelCandidates } = require('./sellerAliasHandoffPreload');
const { env } = require('../config/env');

const managedIdCache = new WeakMap();

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function managedOperationalNames() {
  return [...new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ].map((item) => normalizeName(item)).filter(Boolean))];
}

function sellerByExactName(labelName) {
  const wanted = normalizeName(labelName);
  for (const seller of Object.keys(env.sellerLabelRules || {})) {
    if (normalizeName(seller) === wanted) return seller;
  }
  return null;
}

async function readManagedOperationalIds(client, options = {}) {
  if (!client?.page?.evaluate) {
    return { available: false, ids: new Set(), names: managedOperationalNames() };
  }

  const now = Date.now();
  const cached = managedIdCache.get(client);
  const ttlMs = Math.max(5000, Number(options.ttlMs || 30000));
  if (!options.refresh && cached && (now - cached.at) < ttlMs) return cached.value;

  const names = managedOperationalNames();
  try {
    const result = await client.page.evaluate(async ({ names }) => {
      const WPP = window.WPP || null;
      if (typeof WPP?.labels?.getAllLabels !== 'function') {
        return { available: false, ids: [] };
      }
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const managed = new Set(names.map(normalize));
      const raw = await WPP.labels.getAllLabels();
      const labels = Array.isArray(raw) ? raw : Object.values(raw || {});
      return {
        available: true,
        ids: labels
          .filter((item) => managed.has(normalize(item?.name || item?.label)))
          .map((item) => String(item?.id?._serialized || item?.id || item?.labelId || ''))
          .filter(Boolean),
      };
    }, { names });

    const value = {
      available: result?.available === true,
      ids: new Set(result?.ids || []),
      names,
    };
    if (value.available) managedIdCache.set(client, { at: now, value });
    return value;
  } catch (error) {
    console.warn('[HANDOFF] não foi possível resolver IDs das etiquetas internas:', error?.message || error);
    return { available: false, ids: new Set(), names };
  }
}

function classifyAttachedLabels(items = [], managed = { available: false, ids: new Set(), names: [] }) {
  if (!managed.available) return { external: null, conclusive: false, reason: 'managed_label_ids_unavailable' };

  const managedNames = new Set(managed.names || []);
  for (const item of items || []) {
    const id = String(item?.id?._serialized || item?.id || item?.labelId || '').trim();
    const labelName = String(item?.name || item?.label || '').trim();

    if (id && managed.ids.has(id)) continue;
    if (!id && managedNames.has(normalizeName(labelName))) {
      return { external: null, conclusive: false, reason: 'attached_label_id_unavailable' };
    }

    const seller = sellerByExactName(labelName);
    return {
      conclusive: true,
      external: {
        assigned: true,
        reason: seller ? 'seller_label' : 'manual_label',
        source: 'external_label',
        seller,
        labelName: labelName || null,
        labelId: id || null,
        matchMode: seller ? 'exact_seller_name' : 'external_label_id',
      },
    };
  }

  return { external: null, conclusive: true, reason: 'only_managed_labels' };
}

async function detectExternalLabelAssignment(channel, clientId) {
  if (!env.sellerLabelBlockingEnabled || !channel?.client) {
    return { assigned: false, conclusive: false, source: 'disabled' };
  }

  const managed = await readManagedOperationalIds(channel.client);
  if (!managed.available) {
    return { assigned: false, conclusive: false, source: 'label_api_unavailable' };
  }

  const resolution = await resolveSellerLabelCandidates(channel, clientId);
  let inspectionAvailable = false;
  let chatFound = false;
  let inspectedPhoneAlias = false;

  for (const chatId of resolution.candidates || []) {
    const inspection = await SellerHandoff._test.inspectChatLabels(channel.client, chatId);
    if (inspection?.available) inspectionAvailable = true;
    if (inspection?.chatFound) chatFound = true;
    if (chatId.endsWith('@c.us') && inspection?.available && inspection?.chatFound) {
      inspectedPhoneAlias = true;
    }

    const classified = classifyAttachedLabels(inspection?.items || [], managed);
    if (classified.external) {
      return {
        ...classified.external,
        chatId,
        conclusive: true,
        inspectionAvailable,
        chatFound,
        identityResolution: resolution,
      };
    }
    if (!classified.conclusive) {
      return {
        assigned: false,
        conclusive: false,
        source: classified.reason,
        inspectionAvailable,
        chatFound,
        identityResolution: resolution,
      };
    }
  }

  const conclusive = inspectionAvailable
    && chatFound
    && resolution.conclusiveIdentity
    && (!resolution.direct?.endsWith('@lid') || inspectedPhoneAlias);

  return {
    assigned: false,
    conclusive,
    source: conclusive ? 'only_managed_labels' : 'label_inspection_inconclusive',
    inspectionAvailable,
    chatFound,
    identityResolution: resolution,
  };
}

function existingBlockAcrossAliases(clientId, candidates = []) {
  const ids = Cancellation.candidateChatIds(clientId);
  for (const value of candidates || []) ids.push(Identity.normalizeChatId(value));
  for (const chatId of [...new Set(ids.filter(Boolean))]) {
    const current = HumanControl.getBlock(chatId);
    if (current?.blocked) return { chatId, control: current.control };
  }
  return null;
}

function persistPermanentBlock(clientId, assignment) {
  const payload = {
    reason: assignment.reason || 'manual_label',
    source: assignment.source || 'external_label',
    seller: assignment.seller || null,
    labelName: assignment.labelName || null,
    persistent: true,
  };
  const candidates = assignment?.identityResolution?.candidates || [];
  for (const chatId of [...new Set([clientId, assignment.chatId, ...candidates].filter(Boolean))]) {
    HumanControl.setBlock(chatId, payload);
  }
  return payload;
}

function installCancellationRegistry() {
  if (!BufferManager.prototype.__handoffRegistryInstalled) {
    const originalPush = BufferManager.prototype.push;
    BufferManager.prototype.push = function pushRegistered(...args) {
      Cancellation.registerBuffer(this);
      return originalPush.apply(this, args);
    };
    BufferManager.prototype.__handoffRegistryInstalled = true;
  }

  if (!ChatTaskQueue.prototype.__handoffRegistryInstalled) {
    const originalEnqueue = ChatTaskQueue.prototype.enqueue;
    ChatTaskQueue.prototype.enqueue = function enqueueRegistered(...args) {
      Cancellation.registerQueue(this);
      return originalEnqueue.apply(this, args);
    };
    ChatTaskQueue.prototype.__handoffRegistryInstalled = true;
  }
}

function installPermanentLabelHandoff() {
  if (SellerHandoff.__permanentExternalLabelHandoffInstalled) return;

  SellerHandoff.detectSellerLabelAssignment = detectExternalLabelAssignment;

  SellerHandoff.getAutomationBlock = async function getPermanentAutomationBlock(channel, clientId) {
    const known = existingBlockAcrossAliases(clientId);
    if (known?.control) {
      return {
        blocked: true,
        reason: known.control.reason || 'human_block',
        seller: known.control.seller || null,
        labelName: known.control.labelName || null,
        source: known.control.source || 'human_control',
        details: { inheritedFrom: known.chatId, control: known.control },
      };
    }

    const assignment = await detectExternalLabelAssignment(channel, clientId);
    if (assignment.assigned) {
      persistPermanentBlock(clientId, assignment);
      Cancellation.cancelContact(clientId, assignment.reason || 'external_label');
      console.log(
        `[HANDOFF] etiqueta externa detectada; bloqueio permanente salvo | cliente=${clientId} `
        + `| etiqueta="${assignment.labelName || '-'}" | id=${assignment.labelId || '-'} `
        + `| motivo=${assignment.reason}`,
      );
      return {
        blocked: true,
        reason: assignment.reason,
        seller: assignment.seller || null,
        labelName: assignment.labelName || null,
        source: assignment.source,
        details: assignment,
      };
    }

    if (!assignment.conclusive) {
      return {
        blocked: true,
        temporary: true,
        persisted: false,
        reason: 'label_inspection_inconclusive',
        source: assignment.source || 'label_inspection_inconclusive',
        details: assignment,
      };
    }

    return { blocked: false, reason: null, source: assignment.source };
  };

  SellerHandoff.registerManualTakeover = function registerPermanentManualTakeover(clientId, payload = {}) {
    const assignment = {
      reason: payload.reason || 'manual_outbound_message',
      source: payload.source || 'manual_outbound_message',
      seller: payload.seller || null,
      labelName: payload.labelName || null,
      chatId: clientId,
    };
    const block = HumanControl.setBlock(clientId, { ...assignment, persistent: true });
    Cancellation.cancelContact(clientId, assignment.reason);
    return block;
  };

  SellerHandoff.__permanentExternalLabelHandoffInstalled = true;
}

function blockError(clientId, type, guard) {
  const error = new Error(
    `Envio automático bloqueado para ${clientId}: ${guard?.reason || 'human_handoff'}`,
  );
  error.code = 'HUMAN_HANDOFF_BLOCKED';
  error.chatId = clientId;
  error.outboundType = type;
  error.guard = guard;
  return error;
}

function installTransportGuards(channel) {
  if (!channel || channel.__permanentHandoffTransportGuardInstalled) return channel;

  const beforeSend = async (clientId, type) => {
    const guard = await SellerHandoff.getAutomationBlock(channel, clientId);
    if (!guard?.blocked) return true;
    console.warn(
      `[ENVIO] bloqueado antes do transporte | cliente=${clientId} | tipo=${type} `
      + `| motivo=${guard.reason} | temporário=${guard.temporary ? 'sim' : 'não'}`,
    );
    throw blockError(clientId, type, guard);
  };

  const client = channel.client;
  for (const method of ['sendText', 'sendImage', 'sendFile', 'sendListMessage', 'sendList']) {
    if (typeof client?.[method] !== 'function') continue;
    const original = client[method].bind(client);
    client[method] = async function guardedClientTransport(clientId, ...args) {
      await beforeSend(clientId, method);
      return original(clientId, ...args);
    };
  }

  if (typeof channel.sendCatalog === 'function') {
    const originalSendCatalog = channel.sendCatalog.bind(channel);
    channel.sendCatalog = async function guardedCatalog(clientId, ...args) {
      await beforeSend(clientId, 'catalog');
      return originalSendCatalog(clientId, ...args);
    };
  }

  channel.__beforeAutomationSend = beforeSend;
  channel.__permanentHandoffTransportGuardInstalled = true;
  return channel;
}

function wrapChannelFactory(name) {
  const original = WppClient[name];
  if (typeof original !== 'function' || original.__permanentHandoffWrapped) return;
  const wrapped = async function createChannelWithPermanentHandoff(...args) {
    const channel = await original(...args);
    return installTransportGuards(channel);
  };
  wrapped.__permanentHandoffWrapped = true;
  WppClient[name] = wrapped;
}

installCancellationRegistry();
installPermanentLabelHandoff();
wrapChannelFactory('createWppChannel');

console.log('[HANDOFF] etiquetas externas=permanente | remoção=não libera | envio=protegido no transporte');

module.exports = {
  classifyAttachedLabels,
  detectExternalLabelAssignment,
  existingBlockAcrossAliases,
  installPermanentLabelHandoff,
  installTransportGuards,
  managedOperationalNames,
  readManagedOperationalIds,
  sellerByExactName,
};
