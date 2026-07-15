'use strict';

const ServiceLabels = require('./serviceLabels');
const Identity = require('../services/contactIdentity');

const resolutionCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function normalizeChatId(value) {
  return Identity.normalizeChatId(value);
}

function cachedResolution(chatId) {
  const item = resolutionCache.get(chatId);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    resolutionCache.delete(chatId);
    return null;
  }
  return item.cUsId || null;
}

function rememberResolution(lid, cUsId) {
  resolutionCache.set(lid, {
    cUsId,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function markInternalAliases(channel, ...ids) {
  const mark = channel?.__markInternalLabelOperation;
  if (typeof mark !== 'function') return;

  const candidates = [];
  for (const id of ids) {
    const normalized = normalizeChatId(id);
    if (normalized) candidates.push(normalized);
    try {
      candidates.push(...Identity.getLabelCandidateIds(id).map(normalizeChatId));
    } catch (_) {}
  }

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try { mark(candidate); } catch (_) {}
  }
}

async function resolvePhoneJid(channel, clientId) {
  const direct = normalizeChatId(clientId);
  if (!direct || !direct.endsWith('@lid')) return direct || null;

  const known = Identity.getLabelCandidateIds(direct)
    .map(normalizeChatId)
    .find((candidate) => candidate.endsWith('@c.us'));
  if (known) return known;

  const cached = cachedResolution(direct);
  if (cached) return cached;

  const client = channel?.client;
  if (!client?.page?.evaluate) return null;

  let resolved = null;
  try {
    resolved = await client.page.evaluate(async ({ lid }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;

      const serialized = (value) => {
        if (!value) return '';
        if (typeof value === 'string') return value;
        if (value?._serialized) return String(value._serialized);
        if (value?.id?._serialized) return String(value.id._serialized);
        if (value?.user && value?.server) return `${value.user}@${value.server}`;
        return '';
      };

      if (typeof WPP?.contact?.getPnLidEntry === 'function') {
        try {
          const entry = await WPP.contact.getPnLidEntry(lid);
          const phoneJid = serialized(entry?.phoneNumber);
          if (phoneJid.endsWith('@c.us')) {
            return { cUsId: phoneJid, mode: 'getPnLidEntry' };
          }
        } catch (_) {}
      }

      let chat = null;
      try {
        chat = Store?.Chat?.get?.(lid) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(lid);
      } catch (_) {}

      const contact = chat?.contact || null;
      const candidates = [
        contact?.phoneNumber,
        contact?.pn,
        contact?.phone,
        contact?.id,
        chat?.phoneNumber,
        chat?.pn,
      ];

      for (const candidate of candidates) {
        const phoneJid = serialized(candidate);
        if (phoneJid.endsWith('@c.us')) {
          return { cUsId: phoneJid, mode: 'contact-model' };
        }
      }

      return { cUsId: null, mode: 'not-found' };
    }, { lid: direct });
  } catch (error) {
    console.warn(`[IDENTIDADE] falha ao resolver ${direct} para etiqueta: ${error?.message || error}`);
    return null;
  }

  const cUsId = normalizeChatId(resolved?.cUsId);
  if (!cUsId || !cUsId.endsWith('@c.us')) {
    console.warn(`[IDENTIDADE] número real não encontrado para ${direct}; etiqueta tentará usar o LID.`);
    return null;
  }

  Identity.registerContact({
    chatId: direct,
    phone: cUsId,
    raw: {
      from: direct,
      sender: { id: cUsId },
    },
  });
  rememberResolution(direct, cUsId);
  console.log(`[IDENTIDADE] LID resolvido para etiqueta: ${direct} -> ${cUsId} | modo=${resolved?.mode || '-'}`);
  return cUsId;
}

function installLidServiceLabelFix() {
  if (ServiceLabels.__lidServiceLabelFixInstalled) return ServiceLabels;

  const originalReplaceServiceLabel = ServiceLabels.replaceServiceLabel.bind(ServiceLabels);
  const originalApplyNamedLabel = ServiceLabels.applyNamedLabel.bind(ServiceLabels);

  ServiceLabels.replaceServiceLabel = async function replaceServiceLabelWithResolvedId(channel, clientId, service) {
    markInternalAliases(channel, clientId);
    const resolvedClientId = await resolvePhoneJid(channel, clientId);
    markInternalAliases(channel, clientId, resolvedClientId);
    try {
      return await originalReplaceServiceLabel(channel, resolvedClientId || clientId, service);
    } finally {
      markInternalAliases(channel, clientId, resolvedClientId);
    }
  };

  ServiceLabels.applyNamedLabel = async function applyNamedLabelWithResolvedId(channel, clientId, target) {
    markInternalAliases(channel, clientId);
    const resolvedClientId = await resolvePhoneJid(channel, clientId);
    markInternalAliases(channel, clientId, resolvedClientId);
    try {
      return await originalApplyNamedLabel(channel, resolvedClientId || clientId, target);
    } finally {
      markInternalAliases(channel, clientId, resolvedClientId);
    }
  };

  ServiceLabels.__lidServiceLabelFixInstalled = true;
  return ServiceLabels;
}

module.exports = {
  installLidServiceLabelFix,
  resolvePhoneJid,
  _test: {
    markInternalAliases,
    resolutionCache,
  },
};
