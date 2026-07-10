' strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
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

function desiredHex(color) {
  const normalized = String(color || '').trim().toLowerCase();
  const map = {
    green: '#00a884',
    red: '#ea0038',
    gray: '#667781',
    grey: '#667781',
    blue: '#027eb5',
    yellow: '#f7b928',
    orange: '#ff7a00',
    purple: '#7f66ff',
    pink: '#ff7eb6',
  };
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : (map[normalized] || '#667781');
}

function labelId(label) {
  return String(label?.id || label?.labelId || '').trim();
}

function labelName(label) {
  return String(label?.name || label?.label || '').trim();
}

async function getAllLabels(client) {
  if (typeof client?.getAllLabels !== 'function') return [];
  try {
    const labels = await client.getAllLabels();
    return Array.isArray(labels) ? labels : Object.values(labels || {});
  } catch (err) {
    console.warn('[ETIQUETA] não foi possível listar etiquetas:', err?.message || err);
    return [];
  }
}

async function buildOptionsFromClient(client, target, replaceGroup) {
  let labels = await getAllLabels(client);
  let targetLabel = labels.find((label) => normalizeName(labelName(label)) === normalizeName(target.name));

  if (!targetLabel && typeof client?.addNewLabel === 'function') {
    try {
      // Sem cor fixa aqui: a API escolhe uma cor válida da paleta quando o wrapper
      // não expõe getLabelColorPalette de forma confiável.
      await client.addNewLabel(target.name);
      labels = await getAllLabels(client);
      targetLabel = labels.find((label) => normalizeName(labelName(label)) === normalizeName(target.name));
    } catch (err) {
      console.warn(`[ETIQUETA] wrapper não conseguiu criar "${target.name}":`, err?.message || err);
    }
  }

  const targetId = labelId(targetLabel);
  if (!targetId) return [];

  const removableNames = new Set(replaceGroup.map(normalizeName));
  const options = labels
    .filter((label) => removableNames.has(normalizeName(labelName(label))))
    .map((label) => ({
      labelId: labelId(label),
      type: labelId(label) === targetId ? 'add' : 'remove',
    }))
    .filter((item) => item.labelId);

  if (!options.some((item) => item.labelId === targetId && item.type === 'add')) {
    options.push({ labelId: targetId, type: 'add' });
  }

  return options;
}

async function applyThroughWaJs(client, chatId, target, replaceGroup) {
  if (!client?.page?.evaluate) return { applied: false, verified: false, reason: 'page_unavailable' };

  return client.page.evaluate(async ({ chatId, target, replaceGroup, requestedHex }) => {
    const WPP = window.WPP || null;
    if (!WPP?.labels?.getAllLabels || !WPP?.labels?.addOrRemoveLabels) {
      return { applied: false, verified: false, reason: 'labels_api_unavailable' };
    }

    function normalize(value) {
      return String(value || '').trim().toLowerCase();
    }

    function rgb(hex) {
      const clean = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
      return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
      ];
    }

    function closestPaletteColor(palette, wantedHex) {
      const wanted = rgb(wantedHex);
      if (!wanted || !Array.isArray(palette) || !palette.length) return null;
      let best = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const item of palette) {
        const candidate = rgb(item);
        if (!candidate) continue;
        const distance = ((candidate[0] - wanted[0]) ** 2)
          + ((candidate[1] - wanted[1]) ** 2)
          + ((candidate[2] - wanted[2]) ** 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = item;
        }
      }
      return best;
    }

    let labels = await WPP.labels.getAllLabels();
    labels = Array.isArray(labels) ? labels : Object.values(labels || {});
    let targetLabel = labels.find((label) => normalize(label?.name) === normalize(target.name));

    if (!targetLabel) {
      if (!WPP.labels.addNewLabel) {
        return { applied: false, verified: false, reason: 'add_label_unavailable' };
      }

      let palette = [];
      if (WPP.labels.getLabelColorPalette) {
        palette = await WPP.labels.getLabelColorPalette();
      }
      const paletteColor = closestPaletteColor(palette, requestedHex);
      const options = paletteColor ? { labelColor: paletteColor } : {};
      targetLabel = await WPP.labels.addNewLabel(target.name, options);
      labels = await WPP.labels.getAllLabels();
      labels = Array.isArray(labels) ? labels : Object.values(labels || {});
      targetLabel = labels.find((label) => normalize(label?.name) === normalize(target.name)) || targetLabel;
    }

    const targetId = String(targetLabel?.id || '');
    if (!targetId) {
      return { applied: false, verified: false, reason: 'target_label_missing' };
    }

    const group = replaceGroup.map(normalize);
    const operations = labels
      .filter((label) => group.includes(normalize(label?.name)))
      .map((label) => ({
        labelId: String(label.id),
        type: String(label.id) === targetId ? 'add' : 'remove',
      }));

    if (!operations.some((item) => item.labelId === targetId && item.type === 'add')) {
      operations.push({ labelId: targetId, type: 'add' });
    }

    await WPP.labels.addOrRemoveLabels([chatId], operations);
    await new Promise((resolve) => setTimeout(resolve, 700));

    let verified = null;
    try {
      const Store = window.Store || null;
      const chat = Store?.Chat?.get?.(chatId) || Store?.Chat?.find?.(chatId) || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      if (chat && typeof labelStore?.getLabelsForModel === 'function') {
        const attached = labelStore.getLabelsForModel(chat) || [];
        const list = Array.isArray(attached) ? attached : Object.values(attached || {});
        verified = list.some((label) => String(label?.id || label) === targetId);
      }
    } catch (_) {
      verified = null;
    }

    return {
      applied: true,
      verified,
      chatId,
      targetId,
      targetName: target.name,
      operations,
    };
  }, {
    chatId,
    target,
    replaceGroup,
    requestedHex: desiredHex(target.color),
  });
}

async function applyThroughWrapper(client, chatId, target, replaceGroup) {
  if (typeof client?.addOrRemoveLabels !== 'function') {
    return { applied: false, verified: false, reason: 'wrapper_unavailable' };
  }

  const options = await buildOptionsFromClient(client, target, replaceGroup);
  if (!options.length) {
    return { applied: false, verified: false, reason: 'label_not_found' };
  }

  await client.addOrRemoveLabels([chatId], options);
  return { applied: true, verified: null, chatId, operations: options };
}

async function replaceServiceLabel(channel, clientId, service) {
  if (!env.enableContactLabels || !channel?.client) return false;

  const client = channel.client;
  const target = getServiceLabel(service);
  if (!target?.name) return false;

  const replaceGroup = env.serviceLabelReplaceGroup?.length
    ? env.serviceLabelReplaceGroup
    : [env.serviceLabelLetreiro, env.serviceLabelPlotagem, env.serviceLabelOutros];

  const candidates = Identity.getLabelCandidateIds(clientId);
  if (!candidates.length) candidates.push(Identity.normalizeChatId(clientId));

  for (const chatId of candidates.filter(Boolean)) {
    let result = null;

    try {
      result = await applyThroughWaJs(client, chatId, target, replaceGroup);
    } catch (err) {
      console.warn(`[ETIQUETA] WA-JS falhou para ${chatId}:`, err?.message || err);
    }

    if (!result?.applied) {
      try {
        result = await applyThroughWrapper(client, chatId, target, replaceGroup);
      } catch (err) {
        console.warn(`[ETIQUETA] wrapper falhou para ${chatId}:`, err?.message || err);
      }
    }

    if (result?.applied && result.verified === true) {
      console.log(`[ETIQUETA] aplicada e confirmada em ${chatId}: ${target.name}`);
      return true;
    }

    if (result?.applied && result.verified === null) {
      console.log(`[ETIQUETA] operação enviada sem confirmação disponível em ${chatId}: ${target.name}`);
      return true;
    }

    if (result?.applied && result.verified === false) {
      console.warn(`[ETIQUETA] operação executada, mas a etiqueta não foi confirmada em ${chatId}: ${target.name}`);
    } else if (result?.reason) {
      console.warn(`[ETIQUETA] não aplicada em ${chatId}: ${result.reason}`);
    }
  }

  console.warn(`[ETIQUETA] não foi possível aplicar ${target.name} em nenhum identificador conhecido.`);
  return false;
}

module.exports = {
  replaceServiceLabel,
  getServiceLabel,
  normalizeChatId: Identity.normalizeChatId,
};
