'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');

const resolvedLabels = new Map();
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
  const normalized = normalizeName(color);
  if (/^#[0-9a-f]{6}$/i.test(String(color || '').trim())) {
    return String(color).trim().toLowerCase();
  }
  return COLOR_HEX[normalized] || COLOR_HEX.gray;
}

function labelId(label) {
  return String(label?.id || label?.labelId || '').trim();
}

function labelName(label) {
  return String(label?.name || label?.label || '').trim();
}

function labelCount(label) {
  const value = Number(label?.count);
  return Number.isFinite(value) ? value : 0;
}

function hasValidColor(label) {
  return Boolean(label?.hexColor)
    || Number.isFinite(Number(label?.colorIndex ?? label?.colorId ?? label?.color));
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

async function getAllLabels(client) {
  if (typeof client?.getAllLabels !== 'function') return [];
  try {
    const value = await client.getAllLabels();
    return Array.isArray(value) ? value : Object.values(value || {});
  } catch (err) {
    console.warn('[ETIQUETAS] não foi possível listar as etiquetas do WhatsApp:', err?.message || err);
    return [];
  }
}

async function getAllLabelsStable(client, attempts = 4, delayMs = 500) {
  let labels = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    labels = await getAllLabels(client);
    if (labels.length) return labels;
    if (attempt < attempts) await wait(delayMs);
  }
  return labels;
}

function compareLabelIds(a, b) {
  const aId = labelId(a);
  const bId = labelId(b);
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function findCanonicalLabel(labels, targetName) {
  const wanted = normalizeName(targetName);
  const matches = labels
    .filter((item) => normalizeName(labelName(item)) === wanted)
    .filter((item) => labelId(item));

  if (!matches.length) return null;

  const canonical = [...matches].sort((a, b) => {
    const exactA = labelName(a) === String(targetName || '').trim() ? 1 : 0;
    const exactB = labelName(b) === String(targetName || '').trim() ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;

    const countDifference = labelCount(b) - labelCount(a);
    if (countDifference) return countDifference;

    const colorDifference = Number(hasValidColor(b)) - Number(hasValidColor(a));
    if (colorDifference) return colorDifference;

    return compareLabelIds(a, b);
  })[0];

  if (matches.length > 1) {
    console.warn(
      `[ETIQUETAS] duplicatas encontradas para "${targetName}": `
      + `${matches.map((item) => `${labelId(item)}(contatos=${labelCount(item)})`).join(', ')}. `
      + `Reutilizando o ID ${labelId(canonical)}; nenhuma etiqueta será apagada ou editada.`,
    );
  }

  return canonical;
}

async function resolveExistingLabel(
  client,
  target,
  { refresh = false, attempts = 5, delayMs = 500 } = {},
) {
  const key = normalizeName(target?.name);
  if (!key) return null;

  if (!refresh && resolvedLabels.has(key)) return resolvedLabels.get(key);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const labels = await getAllLabels(client);
    const canonical = findCanonicalLabel(labels, target.name);
    if (canonical) {
      resolvedLabels.set(key, canonical);
      console.log(`[ETIQUETAS] etiqueta existente localizada: ${labelName(canonical)} | ID ${labelId(canonical)}`);
      return canonical;
    }
    if (attempt < attempts) await wait(delayMs);
  }

  resolvedLabels.delete(key);
  return null;
}

async function createLabelThroughWaJs(client, target) {
  if (!client?.page?.evaluate) return null;

  return client.page.evaluate(async ({ name, requestedHex }) => {
    const WPP = window.WPP || null;
    if (!WPP?.labels?.addNewLabel) return null;

    let labelColor = requestedHex;
    try {
      if (WPP.labels.getLabelColorPalette) {
        const palette = await WPP.labels.getLabelColorPalette();
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
        if (wanted && Array.isArray(palette) && palette.length) {
          let closest = null;
          let bestDistance = Number.POSITIVE_INFINITY;
          for (const candidateHex of palette) {
            const candidate = rgb(candidateHex);
            if (!candidate) continue;
            const distance = ((candidate[0] - wanted[0]) ** 2)
              + ((candidate[1] - wanted[1]) ** 2)
              + ((candidate[2] - wanted[2]) ** 2);
            if (distance < bestDistance) {
              bestDistance = distance;
              closest = candidateHex;
            }
          }
          if (closest) labelColor = closest;
        }
      }
    } catch (_) {}

    const created = await WPP.labels.addNewLabel(name, { labelColor });
    if (!created) return null;
    return {
      id: String(created?.id || created?.labelId || ''),
      name: String(created?.name || name),
      color: created?.color ?? null,
      colorIndex: created?.colorIndex ?? null,
      hexColor: created?.hexColor || null,
      count: Number(created?.count || 0),
    };
  }, {
    name: target.name,
    requestedHex: desiredHex(target.color),
  });
}

async function createMissingLabelOnce(client, target) {
  const key = normalizeName(target?.name);
  if (!key) return null;
  if (creationLocks.has(key)) return creationLocks.get(key);

  const task = (async () => {
    const existing = await resolveExistingLabel(client, target, {
      refresh: true,
      attempts: 7,
      delayMs: 600,
    });
    if (existing) return existing;

    console.warn(`[ETIQUETAS] "${target.name}" não foi encontrada; criando uma etiqueta Business válida uma única vez.`);

    let created = null;
    try {
      created = await createLabelThroughWaJs(client, target);
    } catch (err) {
      console.warn(`[ETIQUETAS] WA-JS não conseguiu criar "${target.name}":`, err?.message || err);
    }

    if (!created && typeof client?.addNewLabel === 'function') {
      try {
        await client.addNewLabel(target.name, { labelColor: desiredHex(target.color) });
      } catch (err) {
        console.warn(`[ETIQUETAS] wrapper não conseguiu criar "${target.name}":`, err?.message || err);
      }
    }

    await wait(1400);
    return resolveExistingLabel(client, target, {
      refresh: true,
      attempts: 7,
      delayMs: 600,
    });
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
    console.log('[ETIQUETAS] auditoria inicial somente leitura usando WPP.labels...');
    const labels = await getAllLabelsStable(channel.client, 6, 600);
    let ready = true;

    for (const target of serviceTargets()) {
      const label = findCanonicalLabel(labels, target.name);
      if (!label) {
        ready = false;
        console.warn(
          `[ETIQUETAS] ainda não localizada: ${target.name}. `
          + 'Ela só será criada, com nome válido, quando esse serviço for realmente selecionado.',
        );
        continue;
      }
      resolvedLabels.set(normalizeName(target.name), label);
      console.log(`[ETIQUETAS] pronta: ${labelName(label)} | ID ${labelId(label)}`);
    }

    initializationFinished = true;
    return ready;
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

function normalizeAttachedLabelId(item) {
  return String(item?.id?._serialized || item?.id || item?.labelId || item || '').trim();
}

async function inspectChatLabel(client, chatId, targetId) {
  if (!client?.page?.evaluate) {
    return { available: false, chatFound: null, attached: null };
  }

  try {
    return await client.page.evaluate(async ({ chatId, targetId }) => {
      const Store = window.Store || null;
      let chat = null;

      try {
        chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') {
          chat = await Store.Chat.find(chatId);
        }
      } catch (_) {}

      if (!chat) return { available: true, chatFound: false, attached: false };

      const labelStore = Store?.Label || Store?.Labels || null;
      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { available: false, chatFound: true, attached: null };
      }

      try {
        const value = labelStore.getLabelsForModel(chat) || [];
        const attached = Array.isArray(value) ? value : Object.values(value || {});
        const ids = attached.map((item) => String(
          item?.id?._serialized || item?.id || item?.labelId || item || '',
        ));
        return {
          available: true,
          chatFound: true,
          attached: ids.includes(String(targetId)),
          attachedIds: ids,
        };
      } catch (_) {
        return { available: false, chatFound: true, attached: null };
      }
    }, { chatId, targetId: String(targetId) });
  } catch (err) {
    console.warn(`[ETIQUETAS] não foi possível verificar ${chatId}:`, err?.message || err);
    return { available: false, chatFound: null, attached: null };
  }
}

async function addLabelThroughWaJs(client, chatId, targetId) {
  if (!client?.page?.evaluate) return { supported: false, submitted: false };

  try {
    return await client.page.evaluate(async ({ chatId, targetId }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.addOrRemoveLabels) {
        return { supported: false, submitted: false };
      }
      await WPP.labels.addOrRemoveLabels(
        [chatId],
        [{ labelId: String(targetId), type: 'add' }],
      );
      return { supported: true, submitted: true };
    }, { chatId, targetId: String(targetId) });
  } catch (err) {
    return {
      supported: true,
      submitted: false,
      error: String(err?.message || err),
    };
  }
}

async function addLabelThroughWrapper(client, chatId, targetId) {
  if (typeof client?.addOrRemoveLabels !== 'function') {
    return { supported: false, submitted: false };
  }

  try {
    await client.addOrRemoveLabels(
      [chatId],
      [{ labelId: String(targetId), type: 'add' }],
    );
    return { supported: true, submitted: true };
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

async function applyLabelToCandidates(client, clientId, label) {
  const targetId = labelId(label);
  const candidates = orderedCandidateIds(clientId);
  const unverifiedSuccesses = [];

  for (const chatId of candidates) {
    const before = await inspectChatLabel(client, chatId, targetId);
    if (before.attached === true) {
      return {
        applied: true,
        verified: true,
        alreadyAttached: true,
        mode: 'wpp-labels-existing',
        chatId,
      };
    }

    if (before.available && before.chatFound === false && candidates.length > 1) continue;

    let operation = await addLabelThroughWaJs(client, chatId, targetId);
    let mode = 'wa-js-labels';

    if (!operation.submitted) {
      const wrapperResult = await addLabelThroughWrapper(client, chatId, targetId);
      if (wrapperResult.submitted) {
        operation = wrapperResult;
        mode = 'wppconnect-labels';
      } else if (operation.error || wrapperResult.error) {
        console.warn(
          `[ETIQUETAS] falha ao anexar ID ${targetId} em ${chatId}: `
          + `${operation.error || wrapperResult.error}`,
        );
      }
    }

    if (!operation.submitted) continue;

    await wait(850);
    const after = await inspectChatLabel(client, chatId, targetId);

    if (after.attached === true) {
      return {
        applied: true,
        verified: true,
        mode,
        chatId,
      };
    }

    if (after.available && after.attached === false) {
      console.warn(`[ETIQUETAS] operação não apareceu no chat ${chatId}; tentando outro identificador.`);
      continue;
    }

    unverifiedSuccesses.push({ chatId, mode });
  }

  if (unverifiedSuccesses.length) {
    const fallback = unverifiedSuccesses[0];
    console.warn(
      `[ETIQUETAS] operação enviada para ${fallback.chatId}, mas o WhatsApp não expôs verificação interna.`,
    );
    return {
      applied: true,
      verified: null,
      mode: fallback.mode,
      chatId: fallback.chatId,
    };
  }

  return { applied: false, verified: false };
}

async function applyNamedLabel(channel, clientId, target) {
  if (!env.enableContactLabels || !channel?.client || !target?.name) return false;

  const client = channel.client;
  let label = await resolveExistingLabel(client, target);
  if (!label) label = await createMissingLabelOnce(client, target);

  if (!label) {
    console.warn(`[ETIQUETAS] não foi possível obter uma etiqueta válida chamada "${target.name}".`);
    return false;
  }

  let result = await applyLabelToCandidates(client, clientId, label);

  if (!result?.applied) {
    resolvedLabels.delete(normalizeName(target.name));
    const refreshed = await resolveExistingLabel(client, target, { refresh: true });
    if (refreshed && labelId(refreshed) !== labelId(label)) {
      label = refreshed;
      result = await applyLabelToCandidates(client, clientId, label);
    }
  }

  if (!result?.applied) {
    console.warn(`[ETIQUETAS] não foi possível anexar "${target.name}" ao contato.`);
    return false;
  }

  console.log(
    `[ETIQUETAS] aplicada sem remover ou editar outras: `
    + `${labelName(label)} | ID ${labelId(label)} | ${result.chatId} | verificada=${String(result.verified)}`,
  );

  return {
    ...result,
    targetId: labelId(label),
    targetName: labelName(label),
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
    findCanonicalLabel,
    labelId,
    labelName,
    normalizeAttachedLabelId,
    normalizeName,
    orderedCandidateIds,
  },
};
