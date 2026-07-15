'use strict';

const Store = require('../services/leadStore');
const HumanControl = require('../services/humanControlStore');
const WppClient = require('../services/wppconnectClient');
const SellerHandoff = require('./sellerHandoff');
const { OutboundTracker } = require('./outboundTracker');
const { env } = require('../config/env');

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTimestampMs(message = {}) {
  const candidates = [
    message?.timestamp,
    message?.t,
    message?.messageTimestamp,
    message?.id?.timestamp,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value < 1000000000000 ? value * 1000 : value;
  }

  return null;
}

function isUnreadWithinAge(item = {}, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const maxAgeHours = Math.max(1, Number(options.maxAgeHours || env.unreadBootstrapMaxAgeHours || 24));
  const timestamp = extractTimestampMs(item.raw || item);

  // Algumas versões do WhatsApp não retornam timestamp nesta consulta.
  // Nesses casos, as outras proteções de histórico/handoff continuam valendo.
  if (!timestamp) return true;

  const ageMs = Math.max(0, now - timestamp);
  return ageMs <= (maxAgeHours * 60 * 60 * 1000);
}

function managedNonSellerNames() {
  return new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ].map(normalizeName).filter(Boolean));
}

function findExactSellerLabel(items = []) {
  const ignored = managedNonSellerNames();
  const rules = Object.entries(env.sellerLabelRules || {});

  for (const item of items) {
    const labelName = String(item?.name || '').trim();
    const normalizedLabel = normalizeName(labelName);
    if (!normalizedLabel || ignored.has(normalizedLabel)) continue;

    for (const [seller, sellerColor] of rules) {
      if (normalizedLabel !== normalizeName(seller)) continue;
      return {
        assigned: true,
        seller,
        sellerColor,
        labelName,
        labelId: String(item?.id || ''),
        labelHex: String(item?.hexColor || '').trim().toLowerCase() || null,
        labelColorIndex: Number.isFinite(Number(item?.colorIndex)) ? Number(item.colorIndex) : null,
        matchMode: 'exact_name',
      };
    }
  }

  return null;
}

function installExactSellerHandoff() {
  if (SellerHandoff.__vpsExactSellerHandoffInstalled) return;

  const inspectChatLabels = SellerHandoff?._test?.inspectChatLabels;
  const orderedCandidateIds = SellerHandoff?._test?.orderedCandidateIds;
  if (typeof inspectChatLabels !== 'function' || typeof orderedCandidateIds !== 'function') return;

  SellerHandoff.detectSellerLabelAssignment = async function detectExactSellerLabelAssignment(channel, clientId) {
    if (!env.sellerLabelBlockingEnabled || !channel?.client) {
      return { assigned: false, source: 'disabled', inspectionAvailable: false, chatFound: false };
    }

    let inspectionAvailable = false;
    let chatFound = false;

    for (const chatId of orderedCandidateIds(clientId)) {
      const inspection = await inspectChatLabels(channel.client, chatId);
      if (inspection?.available) inspectionAvailable = true;
      if (inspection?.chatFound) chatFound = true;

      const match = findExactSellerLabel(inspection?.items || []);
      if (match) {
        return {
          ...match,
          chatId,
          source: 'seller_label',
          inspectionAvailable,
          chatFound,
        };
      }
    }

    return {
      assigned: false,
      source: 'none',
      inspectionAvailable,
      chatFound,
    };
  };

  SellerHandoff.getAutomationBlock = async function getAutomationBlockWithExactSeller(channel, clientId) {
    const assignment = await SellerHandoff.detectSellerLabelAssignment(channel, clientId);

    if (assignment?.assigned) {
      HumanControl.setBlock(clientId, {
        reason: 'seller_label',
        source: 'seller_label',
        seller: assignment.seller,
        labelName: assignment.labelName,
        blockedHours: env.humanBlockHours,
      });

      return {
        blocked: true,
        reason: 'seller_label',
        seller: assignment.seller,
        labelName: assignment.labelName,
        source: assignment.source,
        details: assignment,
      };
    }

    const current = HumanControl.getBlock(clientId);
    const reason = String(current?.control?.reason || '');

    // Etiqueta é a fonte de verdade para o responsável. Quando a leitura foi
    // conclusiva e a etiqueta não está mais no contato, libera o fluxo.
    if (current?.blocked
      && reason === 'seller_label'
      && assignment?.inspectionAvailable
      && assignment?.chatFound) {
      HumanControl.clearBlock(clientId);
      console.log(`[HANDOFF] etiqueta de vendedor removida; automação liberada | cliente=${clientId}`);
      return { blocked: false, reason: null, source: 'seller_label_removed' };
    }

    if (current?.blocked) {
      return {
        blocked: true,
        reason: current.control?.reason || 'human_block',
        seller: current.control?.seller || null,
        labelName: current.control?.labelName || null,
        source: current.control?.source || 'human_control',
        details: current.control,
      };
    }

    return { blocked: false, reason: null };
  };

  SellerHandoff.__vpsExactSellerHandoffInstalled = true;
}

function installHumanBlockWriteDeduplication() {
  if (HumanControl.__vpsWriteDeduplicationInstalled) return;

  const originalSetBlock = HumanControl.setBlock.bind(HumanControl);
  HumanControl.setBlock = function setBlockWithoutDuplicateWrites(clientId, payload = {}) {
    const current = HumanControl.getBlock(clientId);
    const existing = current?.control;
    const reason = String(payload.reason || 'human_block');
    const source = String(payload.source || 'manual');
    const seller = String(payload.seller || '');
    const labelName = String(payload.labelName || '');
    const permanentReason = ['manual_outbound_message', 'manual_outbound_history', 'seller_label'].includes(reason);

    if (current?.blocked
      && permanentReason
      && !existing?.blockedUntil
      && String(existing?.reason || '') === reason
      && String(existing?.source || '') === source
      && String(existing?.seller || '') === seller
      && String(existing?.labelName || '') === labelName) {
      return existing;
    }

    return originalSetBlock(clientId, payload);
  };

  HumanControl.__vpsWriteDeduplicationInstalled = true;
}

function installUnreadAgeGuard() {
  if (WppClient.__vpsUnreadAgeGuardInstalled) return;

  const originalCollectUnreadMessages = WppClient.collectUnreadMessages.bind(WppClient);
  WppClient.collectUnreadMessages = async function collectRecentUnreadMessages(client) {
    const items = await originalCollectUnreadMessages(client);
    const recent = [];
    let stale = 0;

    for (const item of items || []) {
      if (isUnreadWithinAge(item)) recent.push(item);
      else stale += 1;
    }

    if (stale) {
      console.log(
        `[RECUPERAÇÃO] ${stale} mensagem(ns) não lida(s) antiga(s) ignorada(s) `
        + `| limite=${env.unreadBootstrapMaxAgeHours}h`,
      );
    }

    return recent;
  };

  WppClient.__vpsUnreadAgeGuardInstalled = true;
}

function installOutboundCacheLimit() {
  if (OutboundTracker.prototype.__vpsCacheLimitInstalled) return;

  const originalRegister = OutboundTracker.prototype.register;
  OutboundTracker.prototype.register = function registerWithBoundedCache(...args) {
    const item = originalRegister.apply(this, args);
    this.purge();

    const maxEntries = Math.max(500, Number(env.runtimeCacheMaxEntries || 5000));
    while (this.byChat?.size > maxEntries) {
      const oldestChatId = this.byChat.keys().next().value;
      if (!oldestChatId) break;
      this.byChat.delete(oldestChatId);
    }

    return item;
  };

  OutboundTracker.prototype.__vpsCacheLimitInstalled = true;
}

function startPeriodicMaintenance() {
  if (global.__personalizeVpsMaintenanceTimer) return;

  const intervalMs = Math.max(60000, Number(env.maintenanceIntervalMs || 900000));
  const run = () => {
    try { Store.purgeExpiredSessions(); } catch (error) {
      console.warn('[MANUTENÇÃO] falha ao limpar sessões:', error?.message || error);
    }
    try { HumanControl.purgeExpiredBlocks(); } catch (error) {
      console.warn('[MANUTENÇÃO] falha ao limpar bloqueios:', error?.message || error);
    }
  };

  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  global.__personalizeVpsMaintenanceTimer = timer;
}

installHumanBlockWriteDeduplication();
installExactSellerHandoff();
installUnreadAgeGuard();
installOutboundCacheLimit();
startPeriodicMaintenance();

console.log(
  `[VPS-READY] vendedores=${Object.keys(env.sellerLabelRules).join(', ')} `
  + `| nãoLidasAté=${env.unreadBootstrapMaxAgeHours}h `
  + `| manutenção=${env.maintenanceIntervalMs}ms `
  + `| cacheMáximo=${env.runtimeCacheMaxEntries}`,
);

module.exports = {
  extractTimestampMs,
  findExactSellerLabel,
  isUnreadWithinAge,
  normalizeName,
};
