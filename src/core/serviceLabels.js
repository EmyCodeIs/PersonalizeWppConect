'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');

const completedGhostCleanupChats = new Set();

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

function listId(item) {
  return String(item?.id?._serialized || item?.id || item?.labelId || '').trim();
}

function listName(item) {
  return String(item?.name || item?.label || '').trim();
}

function desiredHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return COLOR_HEX[normalizeName(raw)] || COLOR_HEX.gray;
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

function orderedCandidateIds(clientId) {
  const direct = Identity.normalizeChatId(clientId);
  const known = Identity.getLabelCandidateIds(clientId);
  return [...new Set([direct, ...known].filter(Boolean))];
}

function configuredReplaceGroup() {
  const configured = Array.isArray(env.serviceLabelReplaceGroup)
    ? env.serviceLabelReplaceGroup
    : [];
  return configured.length
    ? configured
    : [env.serviceLabelLetreiro, env.serviceLabelPlotagem, env.serviceLabelOutros];
}

function configuredGhostIds() {
  return [...new Set((env.legacyGhostLabelIds || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

async function removeLegacyGhostIds(client, chatId) {
  const ghostIds = configuredGhostIds();
  if (completedGhostCleanupChats.has(chatId)) {
    return { removed: [], skipped: ghostIds, alreadyChecked: true };
  }
  if (!ghostIds.length || !client?.page?.evaluate || !chatId) {
    return { removed: [], skipped: [] };
  }

  try {
    const result = await client.page.evaluate(async ({ chatId, ghostIds }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels || !WPP?.labels?.addOrRemoveLabels) {
        return { removed: [], skipped: ghostIds, reason: 'labels_api_unavailable' };
      }

      const StoreWindow = window.Store || null;
      let chat = StoreWindow?.Chat?.get?.(chatId) || null;
      if (!chat && typeof StoreWindow?.Chat?.find === 'function') {
        try { chat = await StoreWindow.Chat.find(chatId); } catch (_) {}
      }
      if (!chat) {
        return { removed: [], skipped: ghostIds, reason: 'chat_not_found' };
      }

      const catalogValue = await WPP.labels.getAllLabels();
      const catalog = Array.isArray(catalogValue)
        ? catalogValue
        : Object.values(catalogValue || {});

      // Se a leitura falhou e retornou vazio, não arriscamos remover nada.
      if (!catalog.length) {
        return { removed: [], skipped: ghostIds, reason: 'empty_catalog' };
      }

      const visibleIds = new Set(catalog.map((item) => String(
        item?.id?._serialized || item?.id || item?.labelId || '',
      )).filter(Boolean));

      const labelStore = StoreWindow?.Label || StoreWindow?.Labels || null;
      if (typeof labelStore?.getLabelsForModel !== 'function') {
        return { removed: [], skipped: ghostIds, reason: 'store_unavailable' };
      }
      const attachedValue = labelStore.getLabelsForModel(chat) || [];
      const attached = Array.isArray(attachedValue)
        ? attachedValue
        : Object.values(attachedValue || {});
      const attachedIds = new Set(attached.map((entry) => String(
        entry?.id?._serialized || entry?.id || entry?.labelId || entry || '',
      )).filter(Boolean));

      const orphanIds = ghostIds.filter((id) => (
        attachedIds.has(String(id)) && !visibleIds.has(String(id))
      ));
      if (!orphanIds.length) return { removed: [], skipped: ghostIds };

      const removed = [];
      for (const id of orphanIds) {
        let detached = false;

        // O editLabel antigo deixou o modelo no LabelStore, mas fora do catálogo.
        // removeChats consegue retirar o vínculo enquanto esse modelo oculto ainda existe.
        try {
          if (WPP?.lists?.removeChats) {
            await WPP.lists.removeChats(String(id), [chatId]);
            detached = true;
          }
        } catch (_) {}

        // Fallback direto para versões em que removeChats não encontra o modelo.
        if (!detached) {
          try {
            await WPP.labels.addOrRemoveLabels(
              [chatId],
              [{ labelId: String(id), type: 'remove' }],
            );
            detached = true;
          } catch (_) {}
        }

        // Só apagamos o modelo local depois de confirmar que o contato foi desvinculado.
        if (detached) {
          try {
            if (WPP?.lists?.remove) await WPP.lists.remove(String(id));
          } catch (_) {}
          removed.push(String(id));
        }
      }

      return { removed, skipped: ghostIds.filter((id) => !removed.includes(String(id))) };
    }, { chatId, ghostIds });

    if (!result?.reason || result.removed?.length) {
      completedGhostCleanupChats.add(chatId);
    }
    return result;
  } catch (err) {
    return {
      removed: [],
      skipped: ghostIds,
      reason: 'cleanup_failed',
      error: String(err?.message || err),
    };
  }
}

async function applyThroughListsApi(client, chatId, target, replaceGroup) {
  if (!client?.page?.evaluate) {
    return { applied: false, verified: false, reason: 'page_unavailable' };
  }

  return client.page.evaluate(async ({ chatId, target, replaceGroup, requestedHex }) => {
    const WPP = window.WPP || null;
    if (
      !WPP?.lists?.create
      || !WPP?.lists?.addChats
      || !WPP?.lists?.removeChats
      || !WPP?.labels?.getAllLabels
    ) {
      return { applied: false, verified: false, reason: 'lists_api_unavailable' };
    }

    const StoreWindow = window.Store || null;
    let existingChat = StoreWindow?.Chat?.get?.(chatId) || null;
    if (!existingChat && typeof StoreWindow?.Chat?.find === 'function') {
      try { existingChat = await StoreWindow.Chat.find(chatId); } catch (_) {}
    }
    if (!existingChat) {
      return { applied: false, verified: false, reason: 'chat_not_found' };
    }

    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const idOf = (item) => String(item?.id?._serialized || item?.id || item?.labelId || '');
    const nameOf = (item) => String(item?.name || item?.label || '');
    const toArray = (value) => (Array.isArray(value) ? value : Object.values(value || {}));

    const rgb = (hex) => {
      const clean = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
      return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
      ];
    };

    const closestPaletteIndex = (palette, wantedHex) => {
      const wanted = rgb(wantedHex);
      if (!wanted || !Array.isArray(palette) || !palette.length) return undefined;
      let bestIndex;
      let bestDistance = Number.POSITIVE_INFINITY;
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
          bestIndex = index;
        }
      });
      return bestIndex;
    };

    let lists = toArray(await WPP.labels.getAllLabels());
    let targetList = lists.find((item) => normalize(nameOf(item)) === normalize(target.name));

    if (!targetList) {
      let colorIndex;
      try {
        if (WPP.labels.getLabelColorPalette) {
          colorIndex = closestPaletteIndex(
            toArray(await WPP.labels.getLabelColorPalette()),
            requestedHex,
          );
        }
      } catch (_) {}

      const createdId = String(await WPP.lists.create(
        target.name,
        [],
        Number.isInteger(colorIndex) ? colorIndex : undefined,
      ) || '');

      // O ID retornado não é aceito sozinho. A lista precisa aparecer no catálogo.
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        lists = toArray(await WPP.labels.getAllLabels());
        targetList = lists.find((item) => idOf(item) === createdId)
          || lists.find((item) => normalize(nameOf(item)) === normalize(target.name));
        if (targetList) break;
      }

      if (!targetList) {
        return {
          applied: false,
          verified: false,
          reason: 'created_not_visible',
          createdId,
        };
      }
    }

    const targetId = idOf(targetList);
    if (!targetId) {
      return { applied: false, verified: false, reason: 'target_list_missing' };
    }

    const managedNames = new Set((replaceGroup || []).map(normalize));
    const otherServiceLists = lists.filter((item) => {
      const id = idOf(item);
      return id
        && id !== targetId
        && managedNames.has(normalize(nameOf(item)));
    });

    // Substitui apenas etiquetas de serviço. Etiquetas de vendedores ficam intactas.
    for (const item of otherServiceLists) {
      try {
        await WPP.lists.removeChats(idOf(item), [chatId]);
      } catch (err) {
        const text = String(err?.message || err?.text || err || '');
        if (!/not found|not attached|not in list/i.test(text)) throw err;
      }
    }

    await WPP.lists.addChats(targetId, [chatId]);

    let verified = null;
    try {
      const labelStore = StoreWindow?.Label || StoreWindow?.Labels || null;
      if (typeof labelStore?.getLabelsForModel === 'function') {
        const attachedValue = labelStore.getLabelsForModel(existingChat) || [];
        const attached = toArray(attachedValue);
        verified = attached.some((entry) => String(
          entry?.id?._serialized || entry?.id || entry?.labelId || entry || '',
        ) === targetId);
      }
    } catch (_) {}

    return {
      applied: true,
      verified,
      mode: 'wpp-lists',
      chatId,
      targetId,
      targetName: nameOf(targetList) || target.name,
    };
  }, {
    chatId,
    target,
    replaceGroup,
    requestedHex: desiredHex(target.color),
  });
}

async function applyNamedLabel(channel, clientId, target) {
  if (!env.enableContactLabels || !channel?.client || !target?.name) return false;

  const client = channel.client;
  const candidates = orderedCandidateIds(clientId);
  const replaceGroup = configuredReplaceGroup();

  for (const chatId of candidates) {
    const cleanup = await removeLegacyGhostIds(client, chatId);
    if (cleanup.removed?.length) {
      console.log(`[LISTAS] vínculo fantasma removido de ${chatId}: ${cleanup.removed.join(', ')}`);
    }

    let result;
    try {
      result = await applyThroughListsApi(client, chatId, target, replaceGroup);
    } catch (err) {
      console.warn(`[LISTAS] falha no caminho WPP.lists para ${chatId}:`, err?.message || err);
      continue;
    }

    if (result?.applied) {
      console.log(
        `[LISTAS] aplicada: ${result.targetName} | ID ${result.targetId} `
        + `| ${result.chatId} | verificada=${String(result.verified)}`,
      );
      return result;
    }

    if (result?.reason && result.reason !== 'page_unavailable') {
      console.warn(`[LISTAS] não aplicada em ${chatId}: ${result.reason}`);
    }
  }

  console.warn(`[LISTAS] não foi possível incluir o contato em "${target.name}".`);
  return false;
}

async function replaceServiceLabel(channel, clientId, service) {
  return applyNamedLabel(channel, clientId, getServiceLabel(service));
}

// Mantido apenas por compatibilidade de importação. Não cria, edita ou recolore
// etiquetas na inicialização. A escrita acontece somente quando o cliente escolhe o serviço.
async function initializeServiceLabels() {
  return true;
}

module.exports = {
  initializeServiceLabels,
  replaceServiceLabel,
  applyNamedLabel,
  getServiceLabel,
  normalizeChatId: Identity.normalizeChatId,
  _test: {
    configuredGhostIds,
    desiredHex,
    normalizeName,
    orderedCandidateIds,
    removeLegacyGhostIds,
  },
};
