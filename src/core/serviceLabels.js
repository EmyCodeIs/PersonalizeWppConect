'use strict';

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
    console.warn('[LISTA] não foi possível listar as listas/etiquetas:', err?.message || err);
    return [];
  }
}

async function syncExistingServiceLabelColor(client, target) {
  if (!client?.page?.evaluate || !target?.name || !target?.color) return false;

  try {
    return await client.page.evaluate(async ({ target, requestedHex }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels || !WPP?.labels?.getLabelColorPalette || !WPP?.labels?.editLabel) {
        return false;
      }

      const normalize = (value) => String(value || '').trim().toLowerCase();
      const labelsValue = await WPP.labels.getAllLabels();
      const labels = Array.isArray(labelsValue) ? labelsValue : Object.values(labelsValue || {});
      const found = labels.find((item) => normalize(item?.name) === normalize(target.name));
      if (!found?.id) return false;

      const rgb = (hex) => {
        const clean = String(hex || '').replace('#', '');
        if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
        return [
          parseInt(clean.slice(0, 2), 16),
          parseInt(clean.slice(2, 4), 16),
          parseInt(clean.slice(4, 6), 16),
        ];
      };

      const palette = await WPP.labels.getLabelColorPalette();
      const wanted = rgb(requestedHex);
      if (!wanted || !Array.isArray(palette) || !palette.length) return false;

      let colorIndex;
      let bestDistance = Number.POSITIVE_INFINITY;
      palette.forEach((item, index) => {
        const candidate = rgb(item);
        if (!candidate) return;
        const distance = ((candidate[0] - wanted[0]) ** 2)
          + ((candidate[1] - wanted[1]) ** 2)
          + ((candidate[2] - wanted[2]) ** 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          colorIndex = index;
        }
      });

      if (!Number.isInteger(colorIndex)) return false;
      const currentIndex = Number(found?.colorIndex ?? found?.colorId ?? found?.color);
      if (Number.isFinite(currentIndex) && currentIndex === colorIndex) return true;

      await WPP.labels.editLabel(String(found.id), {
        name: target.name,
        labelColor: colorIndex,
      });
      return true;
    }, {
      target,
      requestedHex: desiredHex(target.color),
    });
  } catch (err) {
    console.warn(`[LISTA] não foi possível atualizar a cor de "${target.name}":`, err?.message || err);
    return false;
  }
}

async function applyThroughListsApi(client, chatId, target, replaceGroup) {
  if (!client?.page?.evaluate) {
    return { applied: false, verified: false, reason: 'page_unavailable' };
  }

  return client.page.evaluate(async ({ chatId, target, replaceGroup, requestedHex }) => {
    const WPP = window.WPP || null;
    if (!WPP?.lists?.create || !WPP?.lists?.addChats || !WPP?.lists?.removeChats) {
      return { applied: false, verified: false, reason: 'lists_api_unavailable' };
    }

    const normalize = (value) => String(value || '').trim().toLowerCase();

    function rgb(hex) {
      const clean = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
      return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
      ];
    }

    function closestPaletteIndex(palette, wantedHex) {
      const wanted = rgb(wantedHex);
      if (!wanted || !Array.isArray(palette) || !palette.length) return undefined;
      let bestIndex;
      let bestDistance = Number.POSITIVE_INFINITY;
      palette.forEach((item, index) => {
        const candidate = rgb(item);
        if (!candidate) return;
        const distance = ((candidate[0] - wanted[0]) ** 2)
          + ((candidate[1] - wanted[1]) ** 2)
          + ((candidate[2] - wanted[2]) ** 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      return bestIndex;
    }

    let lists = [];
    if (WPP.labels?.getAllLabels) {
      const value = await WPP.labels.getAllLabels();
      lists = Array.isArray(value) ? value : Object.values(value || {});
    }

    let targetList = lists.find((item) => normalize(item?.name) === normalize(target.name));

    if (!targetList) {
      let colorIndex;
      if (WPP.labels?.getLabelColorPalette) {
        const palette = await WPP.labels.getLabelColorPalette();
        colorIndex = closestPaletteIndex(palette, requestedHex);
      }

      const createdId = await WPP.lists.create(
        target.name,
        [],
        Number.isInteger(colorIndex) ? colorIndex : undefined
      );

      if (WPP.labels?.getAllLabels) {
        const value = await WPP.labels.getAllLabels();
        lists = Array.isArray(value) ? value : Object.values(value || {});
      }

      targetList = lists.find((item) => String(item?.id || '') === String(createdId))
        || lists.find((item) => normalize(item?.name) === normalize(target.name))
        || { id: String(createdId), name: target.name };
    }

    const targetId = String(targetList?.id || '');
    if (!targetId) {
      return { applied: false, verified: false, reason: 'target_list_missing' };
    }

    const groupNames = replaceGroup.map(normalize);
    const otherLists = lists.filter((item) => {
      const id = String(item?.id || '');
      return id && id !== targetId && groupNames.includes(normalize(item?.name));
    });

    for (const list of otherLists) {
      try {
        await WPP.lists.removeChats(String(list.id), [chatId]);
      } catch (err) {
        const text = String(err?.message || err?.text || err || '');
        if (!/not found|not attached|not in list/i.test(text)) throw err;
      }
    }

    await WPP.lists.addChats(targetId, [chatId]);
    await new Promise((resolve) => setTimeout(resolve, 800));

    let verified = null;
    try {
      const Store = window.Store || null;
      const chat = Store?.Chat?.get?.(chatId) || Store?.Chat?.find?.(chatId) || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      if (chat && typeof labelStore?.getLabelsForModel === 'function') {
        const attached = labelStore.getLabelsForModel(chat) || [];
        const attachedList = Array.isArray(attached) ? attached : Object.values(attached || {});
        verified = attachedList.some((item) => String(item?.id || item) === targetId);
      }
    } catch (_) {
      verified = null;
    }

    return {
      applied: true,
      verified,
      mode: 'lists',
      chatId,
      targetId,
      targetName: target.name,
    };
  }, {
    chatId,
    target,
    replaceGroup,
    requestedHex: desiredHex(target.color),
  });
}

async function buildLegacyOptions(client, target, replaceGroup) {
  let labels = await getAllLabels(client);
  let targetLabel = labels.find((item) => normalizeName(labelName(item)) === normalizeName(target.name));

  if (!targetLabel && typeof client?.addNewLabel === 'function') {
    try {
      await client.addNewLabel(target.name);
      labels = await getAllLabels(client);
      targetLabel = labels.find((item) => normalizeName(labelName(item)) === normalizeName(target.name));
    } catch (err) {
      console.warn(`[LISTA] fallback antigo não conseguiu criar "${target.name}":`, err?.message || err);
    }
  }

  const targetId = labelId(targetLabel);
  if (!targetId) return [];

  const groupNames = new Set(replaceGroup.map(normalizeName));
  const operations = labels
    .filter((item) => groupNames.has(normalizeName(labelName(item))))
    .map((item) => ({
      labelId: labelId(item),
      type: labelId(item) === targetId ? 'add' : 'remove',
    }))
    .filter((item) => item.labelId);

  if (!operations.some((item) => item.labelId === targetId && item.type === 'add')) {
    operations.push({ labelId: targetId, type: 'add' });
  }
  return operations;
}

async function applyThroughLegacyLabels(client, chatId, target, replaceGroup) {
  const operations = await buildLegacyOptions(client, target, replaceGroup);
  if (!operations.length || typeof client?.addOrRemoveLabels !== 'function') {
    return { applied: false, verified: false, reason: 'legacy_labels_unavailable' };
  }
  await client.addOrRemoveLabels([chatId], operations);
  return { applied: true, verified: null, mode: 'legacy-labels', chatId };
}

async function replaceServiceLabel(channel, clientId, service) {
  if (!env.enableContactLabels || !channel?.client) return false;

  const client = channel.client;
  const target = getServiceLabel(service);
  if (!target?.name) return false;

  // Atualiza a cor da lista de serviço já existente. Isso não remove clientes e
  // não toca nas listas dos vendedores, que ficam fora do grupo de substituição.
  await syncExistingServiceLabelColor(client, target);

  const replaceGroup = env.serviceLabelReplaceGroup?.length
    ? env.serviceLabelReplaceGroup
    : [env.serviceLabelLetreiro, env.serviceLabelPlotagem, env.serviceLabelOutros];

  const candidates = Identity.getLabelCandidateIds(clientId);
  if (!candidates.length) candidates.push(Identity.normalizeChatId(clientId));

  for (const chatId of [...new Set(candidates.filter(Boolean))]) {
    let result;

    try {
      result = await applyThroughListsApi(client, chatId, target, replaceGroup);
    } catch (err) {
      console.warn(`[LISTA] API nova falhou para ${chatId}:`, err?.message || err?.text || err);
    }

    if (!result?.applied && result?.reason === 'lists_api_unavailable') {
      console.warn('[LISTA] WPP.lists indisponível nesta versão; usando fallback antigo WPP.labels.');
      try {
        result = await applyThroughLegacyLabels(client, chatId, target, replaceGroup);
      } catch (err) {
        console.warn(`[LISTA] fallback antigo falhou para ${chatId}:`, err?.message || err);
      }
    }

    if (result?.applied && result.verified === true) {
      console.log(`[LISTA] adicionada e confirmada em ${chatId}: ${target.name} (${result.mode})`);
      return true;
    }

    if (result?.applied && result.verified === null) {
      console.log(`[LISTA] operação concluída sem verificação interna disponível em ${chatId}: ${target.name} (${result.mode})`);
      return true;
    }

    if (result?.applied && result.verified === false) {
      console.warn(`[LISTA] operação executada, mas não confirmada em ${chatId}: ${target.name}`);
    } else if (result?.reason && result.reason !== 'lists_api_unavailable') {
      console.warn(`[LISTA] não aplicada em ${chatId}: ${result.reason}`);
    }
  }

  console.warn(`[LISTA] não foi possível adicionar ${target.name} em nenhum identificador conhecido.`);
  return false;
}

module.exports = {
  replaceServiceLabel,
  getServiceLabel,
  normalizeChatId: Identity.normalizeChatId,
};
