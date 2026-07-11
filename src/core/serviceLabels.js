'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');

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

  return [...matches].sort((a, b) => {
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
          count: Number(item?.count || 0),
        }));
      });
      if (Array.isArray(pageItems)) return pageItems;
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

async function createAndConfirmBusinessList(client, target) {
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

    const findVisible = (items, expectedId = '') => items.find((item) => (
      expectedId && String(item?.id?._serialized || item?.id || item?.labelId || '') === expectedId
    )) || items.find((item) => wantedNames.has(normalize(item?.name || item?.label)));

    const before = toArray(await WPP.labels.getAllLabels());
    const existing = findVisible(before);
    if (existing) {
      return {
        ok: true,
        existing: true,
        id: String(existing?.id?._serialized || existing?.id || existing?.labelId || ''),
        name: String(existing?.name || existing?.label || name),
        count: Number(existing?.count || 0),
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
    try {
      createdId = String(await WPP.lists.create(
        name,
        [],
        Number.isInteger(colorIndex) ? colorIndex : undefined,
      ) || '');
    } catch (err) {
      return {
        ok: false,
        reason: 'create_failed',
        error: String(err?.message || err?.text || err || ''),
      };
    }

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = toArray(await WPP.labels.getAllLabels());
      const visible = findVisible(after, createdId);
      if (visible) {
        return {
          ok: true,
          created: true,
          id: String(visible?.id?._serialized || visible?.id || visible?.labelId || ''),
          name: String(visible?.name || visible?.label || name),
          count: Number(visible?.count || 0),
          colorIndex: visible?.colorIndex ?? visible?.colorId ?? visible?.color ?? colorIndex ?? null,
        };
      }
    }

    return {
      ok: false,
      reason: 'created_not_visible',
      createdId,
      error: 'A API retornou um ID, mas a lista não apareceu no catálogo real do WhatsApp.',
    };
  }, {
    name: String(target.name || '').trim(),
    aliases: buildNameAliases(target),
    requestedHex: desiredHex(target.color),
  });
}

async function ensureServiceList(client, target) {
  const key = normalizeName(target?.name);
  if (!key) return null;

  const current = findCanonicalList(await readBusinessLists(client), target);
  if (current) return current;

  if (creationLocks.has(key)) return creationLocks.get(key);

  const task = (async () => {
    const confirmed = findCanonicalList(await readBusinessLists(client), target);
    if (confirmed) return confirmed;

    const created = await createAndConfirmBusinessList(client, target);
    if (!created?.ok || !created?.id) {
      console.warn(
        `[LISTAS] "${target.name}" não foi confirmada no catálogo; nenhuma etiqueta será aplicada. `
        + `${created?.reason || 'sem retorno'} ${created?.error || ''}`.trim(),
      );
      return null;
    }

    const visible = findCanonicalList(await readBusinessLists(client), target);
    if (!visible || listId(visible) !== String(created.id)) {
      console.warn(`[LISTAS] "${target.name}" ainda não está visível; aplicação bloqueada.`);
      return null;
    }

    console.log(`[LISTAS] pronta e visível: ${listName(visible)} | ID ${listId(visible)}`);
    return visible;
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
      if (!item) ready = false;
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
      const StoreWindow = window.Store || null;
      let chat = null;
      try {
        chat = StoreWindow?.Chat?.get?.(chatId) || null;
        if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
          chat = await StoreWindow.Chat.find(chatId);
        }
      } catch (_) {}
      if (!chat) return { available: true, chatFound: false, items: [] };

      let all = [];
      try {
        if (WPP?.labels?.getAllLabels) {
          const value = await WPP.labels.getAllLabels();
          all = Array.isArray(value) ? value : Object.values(value || {});
        }
      } catch (_) {}

      const labelStore = StoreWindow?.Label || StoreWindow?.Labels || null;
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
        const known = all.find((item) => String(item?.id?._serialized || item?.id || item?.labelId || '') === id) || null;
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

async function addChatToVisibleList(client, chatId, targetId) {
  if (client?.page?.evaluate) {
    try {
      return await client.page.evaluate(async ({ chatId, targetId }) => {
        const WPP = window.WPP || null;
        if (!WPP?.labels?.getAllLabels) {
          return { submitted: false, mode: 'unavailable', reason: 'catalog_unavailable' };
        }

        const value = await WPP.labels.getAllLabels();
        const lists = Array.isArray(value) ? value : Object.values(value || {});
        const visible = lists.some((item) => String(item?.id?._serialized || item?.id || item?.labelId || '') === String(targetId));
        if (!visible) {
          return { submitted: false, mode: 'blocked', reason: 'target_not_visible' };
        }

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
        return { submitted: false, mode: 'unavailable', reason: 'write_unavailable' };
      }, { chatId, targetId: String(targetId) });
    } catch (err) {
      return {
        submitted: false,
        mode: 'wpp-error',
        reason: 'write_failed',
        error: String(err?.message || err),
      };
    }
  }

  if (typeof client?.addOrRemoveLabels === 'function') {
    try {
      const lists = await readBusinessLists(client);
      if (!lists.some((item) => listId(item) === String(targetId))) {
        return { submitted: false, mode: 'blocked', reason: 'target_not_visible' };
      }
      await client.addOrRemoveLabels(
        [chatId],
        [{ labelId: String(targetId), type: 'add' }],
      );
      return { submitted: true, mode: 'wrapper-labels' };
    } catch (err) {
      return {
        submitted: false,
        mode: 'wrapper-error',
        reason: 'write_failed',
        error: String(err?.message || err),
      };
    }
  }

  return { submitted: false, mode: 'unavailable', reason: 'write_unavailable' };
}

async function removeExactSubmittedLabel(client, chatId, targetId) {
  if (!client?.page?.evaluate) return false;
  try {
    return await client.page.evaluate(async ({ chatId, targetId }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.addOrRemoveLabels) return false;
      await WPP.labels.addOrRemoveLabels(
        [chatId],
        [{ labelId: String(targetId), type: 'remove' }],
      );
      return true;
    }, { chatId, targetId: String(targetId) });
  } catch (_) {
    return false;
  }
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
  return null;
}

async function applyNamedLabel(channel, clientId, target) {
  if (!env.enableContactLabels || !channel?.client || !target?.name) return false;

  const client = channel.client;
  const item = await ensureServiceList(client, target);
  if (!item) {
    console.warn(`[LISTAS] aplicação bloqueada: "${target.name}" não existe no catálogo real.`);
    return false;
  }

  const targetId = listId(item);
  const candidates = orderedCandidateIds(clientId);

  for (const chatId of candidates) {
    const before = await inspectChatLists(client, chatId);
    persistManualLists(clientId, before.items);

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

    const operation = await addChatToVisibleList(client, chatId, targetId);
    if (!operation.submitted) {
      if (operation.error) console.warn(`[LISTAS] falha ao incluir ${chatId}: ${operation.error}`);
      if (operation.reason === 'target_not_visible') {
        console.warn(`[LISTAS] ID ${targetId} não está visível; escrita cancelada para evitar etiqueta fantasma.`);
        return false;
      }
      continue;
    }

    const catalogAfter = await readBusinessLists(client);
    const stillVisible = catalogAfter.some((entry) => listId(entry) === targetId);
    if (!stillVisible) {
      await removeExactSubmittedLabel(client, chatId, targetId);
      console.warn(`[LISTAS] ID ${targetId} sumiu do catálogo; etiqueta revertida para evitar marcador fantasma.`);
      return false;
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
    listId,
    listName,
    nearestPaletteIndex,
    normalizeName,
    orderedCandidateIds,
  },
};
