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

function hasValidColor(item) {
  return Boolean(item?.hexColor)
    || Number.isFinite(Number(item?.colorIndex ?? item?.colorId ?? item?.color));
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

function managedServiceLabelNames() {
  const configured = Array.isArray(env.serviceLabelReplaceGroup)
    ? env.serviceLabelReplaceGroup
    : [];
  const fallback = serviceTargets().map((item) => item.name);
  return [...new Set((configured.length ? configured : fallback)
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

async function getAllListsFromPage(client) {
  if (!client?.page?.evaluate) return [];
  try {
    return await client.page.evaluate(async () => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels) return [];
      const value = await WPP.labels.getAllLabels();
      const items = Array.isArray(value) ? value : Object.values(value || {});
      return items.map((item) => ({
        id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
        name: String(item?.name || item?.label || ''),
        color: item?.color ?? null,
        colorIndex: item?.colorIndex ?? item?.colorId ?? null,
        hexColor: item?.hexColor || null,
        count: Number(item?.count || 0),
      }));
    });
  } catch (err) {
    console.warn('[LISTAS] leitura pelo WA-JS falhou:', err?.message || err);
    return [];
  }
}

async function getAllLists(client) {
  const pageLists = await getAllListsFromPage(client);
  if (pageLists.length) return pageLists;

  if (typeof client?.getAllLabels !== 'function') return [];
  try {
    const value = await client.getAllLabels();
    return Array.isArray(value) ? value : Object.values(value || {});
  } catch (err) {
    console.warn('[LISTAS] não foi possível listar as listas do WhatsApp:', err?.message || err);
    return [];
  }
}

function compareIds(a, b) {
  const aId = listId(a);
  const bId = listId(b);
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function findCanonicalList(items, targetName) {
  const wanted = normalizeName(targetName);
  const matches = items
    .filter((item) => normalizeName(listName(item)) === wanted)
    .filter((item) => listId(item) && listName(item));

  if (!matches.length) return null;

  const canonical = [...matches].sort((a, b) => {
    const exactA = listName(a) === String(targetName || '').trim() ? 1 : 0;
    const exactB = listName(b) === String(targetName || '').trim() ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;

    const countDifference = listCount(b) - listCount(a);
    if (countDifference) return countDifference;

    const colorDifference = Number(hasValidColor(b)) - Number(hasValidColor(a));
    if (colorDifference) return colorDifference;

    return compareIds(a, b);
  })[0];

  if (matches.length > 1) {
    console.warn(
      `[LISTAS] duplicatas encontradas para "${targetName}": `
      + `${matches.map((item) => `${listId(item)}(conversas=${listCount(item)})`).join(', ')}. `
      + `Reutilizando ${listId(canonical)} sem apagar nenhuma lista.`,
    );
  }

  return canonical;
}

async function resolveExistingList(
  client,
  target,
  { refresh = false, attempts = 6, delayMs = 500 } = {},
) {
  const key = normalizeName(target?.name);
  if (!key) return null;

  if (!refresh && resolvedLists.has(key)) return resolvedLists.get(key);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const items = await getAllLists(client);
    const found = findCanonicalList(items, target.name);
    if (found) {
      resolvedLists.set(key, found);
      console.log(`[LISTAS] existente localizada: ${listName(found)} | ID ${listId(found)}`);
      return found;
    }
    if (attempt < attempts) await wait(delayMs);
  }

  resolvedLists.delete(key);
  return null;
}

async function createListThroughWaJs(client, target) {
  if (!client?.page?.evaluate) return null;

  return client.page.evaluate(async ({ name, requestedHex }) => {
    const WPP = window.WPP || null;
    if (!WPP?.lists?.create && !WPP?.labels?.addNewLabel) return null;

    const rgb = (hex) => {
      const clean = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
      return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
      ];
    };

    let colorIndex;
    try {
      const palette = WPP.labels?.getLabelColorPalette
        ? await WPP.labels.getLabelColorPalette()
        : [];
      const wanted = rgb(requestedHex);
      if (wanted && Array.isArray(palette) && palette.length) {
        let bestDistance = Number.POSITIVE_INFINITY;
        palette.forEach((candidateHex, index) => {
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
    } catch (_) {}

    let createdId = '';

    if (WPP.lists?.create) {
      createdId = String(await WPP.lists.create(
        name,
        [],
        Number.isInteger(colorIndex) ? colorIndex : undefined,
      ));
    } else {
      const created = await WPP.labels.addNewLabel(name, {
        labelColor: Number.isInteger(colorIndex) ? colorIndex : undefined,
      });
      createdId = String(created?.id || created?.labelId || '');
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    let items = [];
    try {
      if (WPP.labels?.getAllLabels) {
        const value = await WPP.labels.getAllLabels();
        items = Array.isArray(value) ? value : Object.values(value || {});
      }
    } catch (_) {}

    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const found = items.find((item) => String(item?.id || item?.labelId || '') === createdId)
      || items.find((item) => normalize(item?.name || item?.label) === normalize(name));

    return {
      id: String(found?.id || found?.labelId || createdId),
      name: String(found?.name || found?.label || name),
      color: found?.color ?? null,
      colorIndex: found?.colorIndex ?? found?.colorId ?? colorIndex ?? null,
      hexColor: found?.hexColor || null,
      count: Number(found?.count || 0),
    };
  }, {
    name: String(target.name || '').trim(),
    requestedHex: desiredHex(target.color),
  });
}

async function ensureServiceList(client, target) {
  const key = normalizeName(target?.name);
  if (!key) return null;

  const existing = await resolveExistingList(client, target, {
    refresh: true,
    attempts: 7,
    delayMs: 500,
  });
  if (existing) return existing;

  if (creationLocks.has(key)) return creationLocks.get(key);

  const task = (async () => {
    const confirmed = await resolveExistingList(client, target, {
      refresh: true,
      attempts: 4,
      delayMs: 600,
    });
    if (confirmed) return confirmed;

    console.log(`[LISTAS] criando uma única vez: ${target.name} (${target.color})`);

    let created;
    try {
      created = await createListThroughWaJs(client, target);
    } catch (err) {
      console.warn(`[LISTAS] falha ao criar "${target.name}":`, err?.message || err);
      return null;
    }

    if (!created?.id || !created?.name) {
      console.warn(`[LISTAS] criação de "${target.name}" não retornou uma lista válida.`);
      return null;
    }

    resolvedLists.set(key, created);
    console.log(`[LISTAS] criada: ${created.name} | ID ${created.id}`);

    const refreshed = await resolveExistingList(client, target, {
      refresh: true,
      attempts: 8,
      delayMs: 600,
    });
    return refreshed || created;
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
    console.log('[LISTAS] garantindo listas de atendimento no WhatsApp Business...');
    await wait(1200);

    let ready = true;
    for (const target of serviceTargets()) {
      const item = await ensureServiceList(channel.client, target);
      if (!item) {
        ready = false;
        console.warn(`[LISTAS] não foi possível preparar: ${target.name}`);
      } else {
        console.log(`[LISTAS] pronta: ${listName(item)} | ID ${listId(item)}`);
      }
    }

    initializationFinished = true;
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
        if (!chat && typeof Store?.Chat?.find === 'function') {
          chat = await Store.Chat.find(chatId);
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

async function addChatToListThroughWaJs(client, chatId, targetId) {
  if (!client?.page?.evaluate) return { supported: false, submitted: false };

  try {
    return await client.page.evaluate(async ({ chatId, targetId }) => {
      const WPP = window.WPP || null;

      if (WPP?.lists?.addChats) {
        await WPP.lists.addChats(String(targetId), [chatId]);
        return { supported: true, submitted: true, mode: 'wpp-lists' };
      }

      if (WPP?.labels?.addOrRemoveLabels) {
        await WPP.labels.addOrRemoveLabels(
          [chatId],
          [{ labelId: String(targetId), type: 'add' }],
        );
        return { supported: true, submitted: true, mode: 'wpp-labels-fallback' };
      }

      return { supported: false, submitted: false };
    }, { chatId, targetId: String(targetId) });
  } catch (err) {
    return {
      supported: true,
      submitted: false,
      error: String(err?.message || err),
    };
  }
}

async function addChatToListThroughWrapper(client, chatId, targetId) {
  if (typeof client?.addOrRemoveLabels !== 'function') {
    return { supported: false, submitted: false };
  }

  try {
    await client.addOrRemoveLabels(
      [chatId],
      [{ labelId: String(targetId), type: 'add' }],
    );
    return { supported: true, submitted: true, mode: 'wrapper-fallback' };
  } catch (err) {
    return {
      supported: true,
      submitted: false,
      error: String(err?.message || err),
    };
  }
}

function orderedCandidateIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  const known = Identity.getLabelCandidateIds(clientId);
  return [...new Set([direct, ...known].filter(Boolean))];
}

async function applyListToCandidates(client, clientId, item) {
  const targetId = listId(item);
  const candidates = orderedCandidateIds(clientId);
  const unverified = [];

  for (const chatId of candidates) {
    const before = await inspectChatLists(client, chatId);

    if (before.chatFound === false && candidates.length > 1) continue;

    persistManualLists(clientId, before.items);

    if (before.items.some((entry) => String(entry.id) === targetId)) {
      return {
        applied: true,
        verified: true,
        alreadyAttached: true,
        mode: 'existing',
        chatId,
      };
    }

    let operation = await addChatToListThroughWaJs(client, chatId, targetId);
    if (!operation.submitted) {
      const fallback = await addChatToListThroughWrapper(client, chatId, targetId);
      if (fallback.submitted) operation = fallback;
    }

    if (!operation.submitted) {
      if (operation.error) {
        console.warn(`[LISTAS] falha ao incluir ${chatId} em ${targetId}: ${operation.error}`);
      }
      continue;
    }

    await wait(900);
    const after = await inspectChatLists(client, chatId);
    persistManualLists(clientId, after.items.length ? after.items : before.items);

    if (after.items.some((entry) => String(entry.id) === targetId)) {
      return {
        applied: true,
        verified: true,
        mode: operation.mode,
        chatId,
      };
    }

    if (after.available && after.chatFound) {
      console.warn(`[LISTAS] inclusão não apareceu em ${chatId}; tentando outro identificador.`);
      continue;
    }

    unverified.push({ chatId, mode: operation.mode });
  }

  if (unverified.length) {
    return {
      applied: true,
      verified: null,
      chatId: unverified[0].chatId,
      mode: unverified[0].mode,
    };
  }

  return { applied: false, verified: false };
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

  let result = await applyListToCandidates(client, clientId, item);

  if (!result?.applied) {
    resolvedLists.delete(normalizeName(target.name));
    const refreshed = await resolveExistingList(client, target, { refresh: true });
    if (refreshed) {
      item = refreshed;
      result = await applyListToCandidates(client, clientId, item);
    }
  }

  if (!result?.applied) {
    console.warn(`[LISTAS] não foi possível incluir o contato em "${target.name}".`);
    return false;
  }

  console.log(
    `[LISTAS] aplicada sem remover outras: ${listName(item)} | ID ${listId(item)} `
    + `| ${result.chatId} | modo=${result.mode} | verificada=${String(result.verified)}`,
  );

  return {
    ...result,
    targetId: listId(item),
    targetName: listName(item),
  };
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
    desiredHex,
    findCanonicalLabel: findCanonicalList,
    listId,
    listName,
    normalizeName,
    orderedCandidateIds,
  },
};
