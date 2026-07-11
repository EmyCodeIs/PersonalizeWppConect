'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');

const resolvedLists = new Map();
const creationLocks = new Map();
let initializationPromise = null;
let initializationFinished = false;

const COLOR_HEX = Object.freeze({
  green: '#00a884',
  red: '#ea0038',
  gray: '#667781',
  grey: '#667781',
  blue: '#027eb5',
  yellow: '#f7b928',
  orange: '#ff7a00',
  purple: '#7f66ff',
  pink: '#ff7eb6',
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function desiredHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return COLOR_HEX[normalizeName(raw)] || COLOR_HEX.gray;
}

function listId(item) {
  return String(item?.id?._serialized || item?.id || item?.labelId || '').trim();
}

function listName(item) {
  return String(item?.name || item?.label || '').trim();
}

function listCount(item) {
  const value = Number(item?.count);
  return Number.isFinite(value) ? value : 0;
}

function getServiceLabel(service) {
  if (service === 'letreiro') {
    return { name: env.serviceLabelLetreiro, color: env.serviceLabelLetreiroColor };
  }
  if (service === 'plotagem') {
    return { name: env.serviceLabelPlotagem, color: env.serviceLabelPlotagemColor };
  }
  return { name: env.serviceLabelOutros, color: env.serviceLabelOutrosColor };
}

function serviceTargets() {
  return [
    getServiceLabel('letreiro'),
    getServiceLabel('plotagem'),
    getServiceLabel('outros'),
  ].filter((item) => item?.name);
}

function buildNameAliases(target) {
  const configuredName = String(target?.name || '').trim();
  const aliases = [configuredName, ...(Array.isArray(target?.aliases) ? target.aliases : [])]
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const variants = [...aliases];
  for (const name of aliases) {
    if (/\bletreiro$/i.test(name)) variants.push(name.replace(/letreiro$/i, 'letreiros'));
    if (/\bletreiros$/i.test(name)) variants.push(name.replace(/letreiros$/i, 'letreiro'));
    if (/\bplotagem$/i.test(name)) variants.push(name.replace(/plotagem$/i, 'plotagens'));
    if (/\bplotagens$/i.test(name)) variants.push(name.replace(/plotagens$/i, 'plotagem'));
    if (/\boutro$/i.test(name)) variants.push(name.replace(/outro$/i, 'outros'));
    if (/\boutros$/i.test(name)) variants.push(name.replace(/outros$/i, 'outro'));
  }

  const seen = new Set();
  return variants.filter((name) => {
    const key = normalizeName(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function managedServiceLabelNames() {
  const configured = Array.isArray(env.serviceLabelReplaceGroup)
    ? env.serviceLabelReplaceGroup
    : [];
  const names = configured.length
    ? configured.flatMap((name) => buildNameAliases({ name }))
    : serviceTargets().flatMap(buildNameAliases);

  const seen = new Set();
  return names.filter((name) => {
    const key = normalizeName(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareIds(a, b) {
  const aId = listId(a);
  const bId = listId(b);
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function findCanonicalList(items, target) {
  const targetObject = typeof target === 'string' ? { name: target } : (target || {});
  const aliases = buildNameAliases(targetObject);
  const aliasOrder = new Map(aliases.map((name, index) => [normalizeName(name), index]));
  const configured = normalizeName(targetObject.name);
  const matches = (Array.isArray(items) ? items : [])
    .filter((item) => listId(item) && listName(item))
    .filter((item) => aliasOrder.has(normalizeName(listName(item))));

  if (!matches.length) return null;

  const canonical = [...matches].sort((a, b) => {
    const usedDifference = Number(listCount(b) > 0) - Number(listCount(a) > 0);
    if (usedDifference) return usedDifference;

    const exactDifference = Number(normalizeName(listName(b)) === configured)
      - Number(normalizeName(listName(a)) === configured);
    if (exactDifference) return exactDifference;

    const countDifference = listCount(b) - listCount(a);
    if (countDifference) return countDifference;

    const aliasDifference = (aliasOrder.get(normalizeName(listName(a))) ?? 999)
      - (aliasOrder.get(normalizeName(listName(b))) ?? 999);
    if (aliasDifference) return aliasDifference;

    return compareIds(a, b);
  })[0];

  if (matches.length > 1) {
    console.warn(
      `[LISTAS] equivalentes/duplicadas para "${targetObject.name}": `
      + `${matches.map((item) => `${listName(item)}#${listId(item)}`).join(', ')}. `
      + `Reutilizando ${listName(canonical)}#${listId(canonical)} sem apagar nenhuma.`,
    );
  }

  return canonical;
}

async function readBusinessLists(client) {
  if (client?.page?.evaluate) {
    try {
      const pageItems = await client.page.evaluate(async () => {
        const WPP = window.WPP || null;
        if (!WPP?.labels?.getAllLabels) return [];
        const value = await WPP.labels.getAllLabels();
        const list = Array.isArray(value) ? value : Object.values(value || {});
        return list.map((item) => ({
          id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
          name: String(item?.name || item?.label || ''),
          colorIndex: item?.colorIndex ?? item?.colorId ?? item?.color ?? null,
          hexColor: item?.hexColor || null,
          count: Number(item?.count || 0),
        }));
      });
      if (Array.isArray(pageItems) && pageItems.length) return pageItems;
    } catch (err) {
      console.warn('[LISTAS] leitura pelo WA-JS falhou:', err?.message || err);
    }
  }

  if (typeof client?.getAllLabels === 'function') {
    try {
      const value = await client.getAllLabels();
      return Array.isArray(value) ? value : Object.values(value || {});
    } catch (err) {
      console.warn('[LISTAS] leitura pelo WPPConnect falhou:', err?.message || err);
    }
  }

  return [];
}

function cacheKey(target) {
  return normalizeName(target?.name);
}

function invalidateResolvedList(target) {
  const key = cacheKey(target);
  if (key) resolvedLists.delete(key);
}

async function resolveExistingList(client, target, options = {}) {
  const key = cacheKey(target);
  if (!key) return null;

  const refresh = Boolean(options.refresh);
  const attempts = Math.max(1, Number(options.attempts || 3));
  const delayMs = Math.max(0, Number(options.delayMs || 400));

  if (!refresh && resolvedLists.has(key)) return resolvedLists.get(key);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const items = await readBusinessLists(client);
    const found = findCanonicalList(items, target);
    if (found) {
      resolvedLists.set(key, found);
      return found;
    }
    if (attempt < attempts) await wait(delayMs);
  }

  resolvedLists.delete(key);
  return null;
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function nearestPaletteIndex(palette, requestedHex) {
  const wanted = hexToRgb(requestedHex);
  if (!wanted || !Array.isArray(palette) || !palette.length) return null;

  let bestIndex = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((entry, index) => {
    const candidateHex = typeof entry === 'string'
      ? entry
      : entry?.hex || entry?.hexColor || entry?.color || entry?.value;
    const candidate = hexToRgb(candidateHex);
    if (!candidate) return;
    const distance = ((candidate[0] - wanted[0]) ** 2)
      + ((candidate[1] - wanted[1]) ** 2)
      + ((candidate[2] - wanted[2]) ** 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return Number.isInteger(bestIndex) ? bestIndex : null;
}

async function createRealBusinessList(client, target) {
  if (!client?.page?.evaluate) return null;

  return client.page.evaluate(async ({ name, aliases, requestedHex }) => {
    const WPP = window.WPP || null;
    if (!WPP?.lists?.create || !WPP?.labels?.getAllLabels) {
      return { ok: false, reason: 'lists_api_unavailable' };
    }

    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const wantedNames = new Set((aliases || []).map(normalize));
    const toArray = (value) => (Array.isArray(value) ? value : Object.values(value || {}));

    const before = toArray(await WPP.labels.getAllLabels());
    const existing = before.find((item) => wantedNames.has(normalize(item?.name || item?.label)));
    if (existing?.id || existing?.labelId) {
      return {
        ok: true,
        existing: true,
        id: String(existing.id || existing.labelId),
        name: String(existing.name || existing.label || name),
        count: Number(existing.count || 0),
        colorIndex: existing?.colorIndex ?? existing?.colorId ?? existing?.color ?? null,
      };
    }

    let palette = [];
    try {
      palette = WPP.labels.getLabelColorPalette
        ? await WPP.labels.getLabelColorPalette()
        : [];
    } catch (_) {}

    const rgb = (hex) => {
      const clean = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
      return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
      ];
    };

    const wanted = rgb(requestedHex);
    let colorIndex;
    let bestDistance = Number.POSITIVE_INFINITY;
    if (wanted && Array.isArray(palette)) {
      palette.forEach((entry, index) => {
        const candidateHex = typeof entry === 'string'
          ? entry
          : entry?.hex || entry?.hexColor || entry?.color || entry?.value;
        const candidate = rgb(candidateHex);
        if (!candidate) return;
        const distance = ((candidate[0] - wanted[0]) ** 2)
          + ((candidate[1] - wanted[1]) ** 2)
          + ((candidate[2] - wanted[2]) ** 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          colorIndex = index;
        }
      });
    }

    let createdId = '';
    let lastError = '';
    for (const requestedIndex of [colorIndex, undefined]) {
      if (requestedIndex === undefined && colorIndex === undefined && createdId) break;
      try {
        createdId = String(await WPP.lists.create(
          name,
          [],
          Number.isInteger(requestedIndex) ? requestedIndex : undefined,
        ));
        if (createdId) break;
      } catch (err) {
        lastError = String(err?.message || err?.text || err || '');
      }
    }

    if (!createdId) return { ok: false, reason: 'create_failed', error: lastError };

    await new Promise((resolve) => setTimeout(resolve, 800));
    const after = toArray(await WPP.labels.getAllLabels());
    const found = after.find((item) => String(item?.id || item?.labelId || '') === createdId)
      || after.find((item) => wantedNames.has(normalize(item?.name || item?.label)));

    return {
      ok: true,
      id: String(found?.id || found?.labelId || createdId),
      name: String(found?.name || found?.label || name),
      count: Number(found?.count || 0),
      colorIndex: found?.colorIndex ?? found?.colorId ?? found?.color ?? colorIndex ?? null,
    };
  }, {
    name: String(target.name || '').trim(),
    aliases: buildNameAliases(target),
    requestedHex: desiredHex(target.color),
  });
}

async function ensureServiceList(client, target) {
  const key = cacheKey(target);
  if (!key) return null;

  const existing = await resolveExistingList(client, target, {
    refresh: true,
    attempts: 3,
    delayMs: 400,
  });
  if (existing) return existing;

  if (creationLocks.has(key)) return creationLocks.get(key);

  const task = (async () => {
    const confirmed = await resolveExistingList(client, target, {
      refresh: true,
      attempts: 2,
      delayMs: 500,
    });
    if (confirmed) return confirmed;

    let created = null;
    try {
      created = await createRealBusinessList(client, target);
    } catch (err) {
      console.warn(`[LISTAS] erro ao criar "${target.name}":`, err?.message || err);
    }

    if (!created?.ok || !created?.id) {
      console.warn(
        `[LISTAS] não foi possível criar "${target.name}": `
        + `${created?.reason || 'sem retorno'} ${created?.error || ''}`.trim(),
      );
      return null;
    }

    const refreshed = await resolveExistingList(client, target, {
      refresh: true,
      attempts: 5,
      delayMs: 500,
    });
    const item = refreshed || created;
    resolvedLists.set(key, item);
    console.log(`[LISTAS] pronta: ${listName(item)} | ID ${listId(item)}`);
    return item;
  })().finally(() => {
    creationLocks.delete(key);
  });

  creationLocks.set(key, task);
  return task;
}

async function initializeServiceLabels(channel) {
  if (!env.enableContactLabels || !channel?.client) return false;
  if (initializationFinished) return true;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    let ready = true;
    for (const target of serviceTargets()) {
      const item = await ensureServiceList(channel.client, target);
      if (!item) {
        ready = false;
        console.warn(`[LISTAS] ausente: ${target.name}`);
      }
    }
    initializationFinished = ready;
    return ready;
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

async function inspectChatLists(client, chatId) {
  if (!client?.page?.evaluate || !chatId) {
    return { available: false, chatFound: null, items: [] };
  }

  try {
    return await client.page.evaluate(async ({ chatId }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      let chat = null;
      try {
        chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
      } catch (_) {}
      if (!chat) return { available: true, chatFound: false, items: [] };

      let all = [];
      try {
        if (WPP?.labels?.getAllLabels) {
          const value = await WPP.labels.getAllLabels();
          all = Array.isArray(value) ? value : Object.values(value || {});
        }
      } catch (_) {}

      const labelStore = Store?.Label || Store?.Labels || null;
      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { available: false, chatFound: true, items: [] };
      }

      let attached = [];
      try {
        const value = labelStore.getLabelsForModel(chat) || [];
        attached = Array.isArray(value) ? value : Object.values(value || {});
      } catch (_) {}

      const items = attached.map((entry) => {
        const id = String(entry?.id?._serialized || entry?.id || entry?.labelId || entry || '');
        const known = all.find((item) => String(item?.id || item?.labelId || '') === id) || null;
        return {
          id,
          name: String(entry?.name || entry?.label || known?.name || known?.label || ''),
          colorIndex: entry?.colorIndex ?? entry?.colorId ?? entry?.color
            ?? known?.colorIndex ?? known?.colorId ?? known?.color ?? null,
        };
      }).filter((item) => item.id);

      return { available: true, chatFound: true, items };
    }, { chatId });
  } catch (err) {
    console.warn(`[LISTAS] não foi possível verificar ${chatId}:`, err?.message || err);
    return { available: false, chatFound: null, items: [] };
  }
}

function persistManualLists(clientId, items = []) {
  if (!env.storeManualContactLabels) return;

  try {
    const managed = new Set(managedServiceLabelNames().map(normalizeName));
    const manual = items
      .filter((item) => item?.name && !managed.has(normalizeName(item.name)))
      .map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || '').trim(),
        colorIndex: Number.isFinite(Number(item.colorIndex)) ? Number(item.colorIndex) : null,
      }))
      .filter((item, index, list) => item.name
        && list.findIndex((candidate) => candidate.id === item.id && candidate.name === item.name) === index)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    const session = Store.getSession(clientId);
    if (!session) return;
    session.dados = session.dados || {};
    session.dados.manualContactLabels = manual;
    session.dados.manualContactLabelNames = manual.map((item) => item.name);
    session.dados.manualContactLabelsDetectedAt = new Date().toISOString();
    Store.saveSession(session);
  } catch (err) {
    console.warn('[LISTAS] não foi possível registrar listas manuais:', err?.message || err);
  }
}

function errorText(error) {
  return String(error?.code || error?.name || '') + ' ' + String(error?.message || error?.text || error || '');
}

function isListNotFound(error) {
  return /list_not_found|label_not_found|list\s+[^\s]+\s+not found|etiqueta.+nao encontrada/i.test(errorText(error));
}

async function addChatToList(client, chatId, targetId) {
  if (client?.page?.evaluate) {
    try {
      return await client.page.evaluate(async ({ chatId, targetId }) => {
        const WPP = window.WPP || null;
        if (WPP?.lists?.addChats) {
          await WPP.lists.addChats(String(targetId), [chatId]);
          return { submitted: true, mode: 'wpp-lists' };
        }
        if (WPP?.labels?.addOrRemoveLabels) {
          await WPP.labels.addOrRemoveLabels(
            [chatId],
            [{ labelId: String(targetId), type: 'add' }],
          );
          return { submitted: true, mode: 'wpp-labels' };
        }
        return { submitted: false, mode: 'unavailable' };
      }, { chatId, targetId: String(targetId) });
    } catch (err) {
      return {
        submitted: false,
        mode: 'wpp-error',
        error: String(err?.message || err),
        staleList: isListNotFound(err),
      };
    }
  }

  if (typeof client?.addOrRemoveLabels === 'function') {
    try {
      await client.addOrRemoveLabels(
        [chatId],
        [{ labelId: String(targetId), type: 'add' }],
      );
      return { submitted: true, mode: 'wrapper-labels' };
    } catch (err) {
      return {
        submitted: false,
        mode: 'wrapper-error',
        error: String(err?.message || err),
        staleList: isListNotFound(err),
      };
    }
  }

  return { submitted: false, mode: 'unavailable' };
}

function orderedCandidateIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  const known = Identity.getLabelCandidateIds(clientId);
  return [...new Set([direct, ...known].filter(Boolean))];
}

async function verifyAttachment(client, chatId, targetId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const inspection = await inspectChatLists(client, chatId);
    if (inspection.items.some((entry) => String(entry.id) === String(targetId))) return true;
    if (!inspection.available || inspection.chatFound === false) return null;
    if (attempt < 3) await wait(650);
  }
  // A escrita não é revertida só porque o Store visual ainda não sincronizou.
  return null;
}

async function applyNamedLabel(channel, clientId, target) {
  if (!env.enableContactLabels || !channel?.client || !target?.name) return false;

  const client = channel.client;
  let item = await resolveExistingList(client, target);
  if (!item) item = await ensureServiceList(client, target);
  if (!item) {
    console.warn(`[LISTAS] não foi possível criar ou localizar "${target.name}".`);
    return false;
  }

  const candidates = orderedCandidateIds(clientId);
  for (const chatId of candidates) {
    const before = await inspectChatLists(client, chatId);
    persistManualLists(clientId, before.items);

    let targetId = listId(item);
    if (before.items.some((entry) => String(entry.id) === targetId)) {
      return {
        applied: true,
        verified: true,
        alreadyAttached: true,
        mode: 'existing',
        chatId,
        targetId,
        targetName: listName(item),
      };
    }

    let operation = await addChatToList(client, chatId, targetId);

    if (!operation.submitted && operation.staleList) {
      console.warn(`[LISTAS] ID ${targetId} ficou inválido; atualizando cache de "${target.name}".`);
      invalidateResolvedList(target);
      item = await resolveExistingList(client, target, {
        refresh: true,
        attempts: 3,
        delayMs: 350,
      });
      if (!item) item = await ensureServiceList(client, target);
      targetId = listId(item);
      if (targetId) operation = await addChatToList(client, chatId, targetId);
    }

    if (!operation.submitted) {
      if (operation.error) console.warn(`[LISTAS] falha ao incluir ${chatId}: ${operation.error}`);
      continue;
    }

    const verified = await verifyAttachment(client, chatId, targetId);
    const after = await inspectChatLists(client, chatId);
    persistManualLists(clientId, after.items.length ? after.items : before.items);

    console.log(
      `[LISTAS] aplicada sem remover outras: ${listName(item)} | ID ${targetId} `
      + `| ${chatId} | modo=${operation.mode} | verificada=${String(verified)}`,
    );

    return {
      applied: true,
      verified,
      chatId,
      mode: operation.mode,
      targetId,
      targetName: listName(item),
    };
  }

  console.warn(`[LISTAS] não foi possível incluir o contato em "${target.name}".`);
  return false;
}

async function replaceServiceLabel(channel, clientId, service) {
  return applyNamedLabel(channel, clientId, getServiceLabel(service));
}

module.exports = {
  initializeServiceLabels,
  replaceServiceLabel,
  applyNamedLabel,
  managedServiceLabelNames,
  getServiceLabel,
  normalizeChatId: Identity.normalizeChatId,
  _test: {
    buildNameAliases,
    desiredHex,
    findCanonicalLabel: findCanonicalList,
    invalidateResolvedList,
    listId,
    listName,
    nearestPaletteIndex,
    normalizeName,
    orderedCandidateIds,
    resolvedLists,
  },
};
