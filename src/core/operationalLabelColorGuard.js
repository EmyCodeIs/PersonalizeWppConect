'use strict';

const DEFAULT_PURPLE_HEX = '#7f66ff';
const DEFAULT_PURPLE_INDEX = 5;
let running = null;

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseColorIndex(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function configuredPurpleIndex() {
  return parseColorIndex(process.env.SERVICE_LABEL_LETREIRO_COLOR_INDEX, DEFAULT_PURPLE_INDEX);
}

async function ensureLetreiroPurpleLabel(channel) {
  if (!channel?.client?.page?.evaluate) {
    return { ready: false, reason: 'page_unavailable' };
  }
  if (running) return running;

  running = (async () => {
    const name = String(process.env.SERVICE_LABEL_LETREIRO || 'Orçamento letreiros').trim();
    const desiredHex = String(process.env.SERVICE_LABEL_LETREIRO_COLOR_HEX || DEFAULT_PURPLE_HEX).trim();
    const fallbackIndex = configuredPurpleIndex();

    const result = await channel.client.page.evaluate(async ({
      name: expectedName,
      desiredHex: expectedHex,
      fallbackIndex: expectedFallbackIndex,
    }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels || !WPP?.lists?.create) {
        return { ready: false, reason: 'lists_api_unavailable' };
      }

      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const itemId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || '');
      const itemName = (item) => String(item?.name || item?.label || '');
      const itemColorIndex = (item) => {
        const value = Number(item?.colorIndex ?? item?.colorId ?? item?.color);
        return Number.isInteger(value) && value >= 0 ? value : null;
      };
      const hexToRgb = (hex) => {
        const clean = String(hex || '').trim().replace('#', '');
        if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
        return [
          parseInt(clean.slice(0, 2), 16),
          parseInt(clean.slice(2, 4), 16),
          parseInt(clean.slice(4, 6), 16),
        ];
      };
      const nearestPaletteIndex = (palette, requestedHex) => {
        const wanted = hexToRgb(requestedHex);
        if (!wanted || !Array.isArray(palette) || !palette.length) return null;
        let bestIndex = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        palette.forEach((entry, index) => {
          const candidate = hexToRgb(typeof entry === 'string'
            ? entry
            : entry?.hex || entry?.hexColor || entry?.color || entry?.value);
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
      };
      const getCatalog = async () => {
        const value = await WPP.labels.getAllLabels();
        return Array.isArray(value) ? value : Object.values(value || {});
      };

      let palette = [];
      try {
        if (WPP?.labels?.getLabelColorPalette) {
          const value = await WPP.labels.getLabelColorPalette();
          palette = Array.isArray(value) ? value : Object.values(value || {});
        }
      } catch (_) {}

      // A paleta real é a primeira fonte. O índice explícito 5 só é usado
      // quando a versão carregada do WhatsApp não devolve a paleta.
      const paletteIndex = nearestPaletteIndex(palette, expectedHex);
      const desiredIndex = Number.isInteger(paletteIndex)
        ? paletteIndex
        : expectedFallbackIndex;
      if (!Number.isInteger(desiredIndex) || desiredIndex < 0) {
        return {
          ready: false,
          reason: 'purple_index_unresolved',
          palette,
        };
      }

      let catalog = await getCatalog();
      const matching = catalog.filter((item) => normalize(itemName(item)) === normalize(expectedName));
      const correct = matching.find((item) => itemColorIndex(item) === desiredIndex) || null;
      if (correct) {
        return {
          ready: true,
          reused: true,
          id: itemId(correct),
          name: itemName(correct),
          colorIndex: desiredIndex,
          paletteIndex,
          palette,
        };
      }

      if (!WPP?.lists?.remove) {
        return {
          ready: false,
          reason: 'wrong_color_and_remove_unavailable',
          existing: matching.map((item) => ({ id: itemId(item), colorIndex: itemColorIndex(item) })),
          desiredIndex,
          palette,
        };
      }

      for (const item of matching) {
        const id = itemId(item);
        if (!id) continue;
        try { await WPP.lists.remove(id); } catch (_) {}
      }

      for (let attempt = 0; attempt < 10; attempt += 1) {
        catalog = await getCatalog();
        const stale = catalog.some((item) => normalize(itemName(item)) === normalize(expectedName));
        if (!stale) break;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }

      const createdId = String(await WPP.lists.create(expectedName, [], desiredIndex) || '');
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        catalog = await getCatalog();
        const visible = catalog.find((item) => (
          itemId(item) === createdId
          || normalize(itemName(item)) === normalize(expectedName)
        ));
        if (!visible) continue;
        const actualIndex = itemColorIndex(visible);
        return {
          ready: actualIndex === desiredIndex,
          created: true,
          id: itemId(visible),
          name: itemName(visible),
          colorIndex: actualIndex,
          desiredIndex,
          paletteIndex,
          palette,
          reason: actualIndex === desiredIndex ? null : 'created_with_unexpected_color',
        };
      }

      return {
        ready: false,
        reason: 'created_but_not_visible',
        createdId,
        desiredIndex,
        paletteIndex,
        palette,
      };
    }, { name, desiredHex, fallbackIndex });

    const paletteText = Array.isArray(result?.palette) && result.palette.length
      ? result.palette.map((color, index) => `${index}:${String(color)}`).join(', ')
      : 'indisponível';
    console.log(
      `[ETIQUETAS] cor de "${name}": pronta=${String(Boolean(result?.ready))} `
      + `índice=${String(result?.colorIndex ?? result?.desiredIndex ?? '-')} paleta=${paletteText}`,
    );
    if (!result?.ready) {
      console.warn(`[ETIQUETAS] não foi possível confirmar a etiqueta roxa: ${result?.reason || 'falha'}`);
    }
    return result;
  })().finally(() => {
    running = null;
  });

  return running;
}

module.exports = {
  ensureLetreiroPurpleLabel,
  _test: {
    configuredPurpleIndex,
    normalizeName,
    parseColorIndex,
  },
};
