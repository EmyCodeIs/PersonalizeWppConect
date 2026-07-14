'use strict';

const { env } = require('../config/env');

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

function titleCase(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function desiredHex(color) {
  const raw = String(color || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  return COLOR_HEX[normalizeName(raw)] || COLOR_HEX.gray;
}

function requiredTargets() {
  const sellers = Object.entries(env.sellerLabelRules || {}).map(([name, color]) => ({
    name: titleCase(name),
    color,
    type: 'vendedor',
  }));

  const targets = [
    { name: env.serviceLabelLetreiro, color: env.serviceLabelLetreiroColor, type: 'serviço' },
    { name: env.serviceLabelPlotagem, color: env.serviceLabelPlotagemColor, type: 'serviço' },
    { name: env.serviceLabelOutros, color: env.serviceLabelOutrosColor, type: 'serviço' },
    {
      name: process.env.SERVICE_LABEL_SUPPORT || 'Suporte',
      color: process.env.SERVICE_LABEL_SUPPORT_COLOR || 'red',
      type: 'suporte',
    },
    ...sellers,
  ];

  const seen = new Set();
  return targets.filter((target) => {
    const key = normalizeName(target.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readLabels(client) {
  if (!client?.page?.evaluate) throw new Error('LABEL_PAGE_UNAVAILABLE');

  return client.page.evaluate(async () => {
    const WPP = window.WPP || null;
    if (!WPP?.labels?.getAllLabels) throw new Error('LABEL_API_UNAVAILABLE');
    const raw = await WPP.labels.getAllLabels();
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    return list.map((item) => ({
      id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
      name: String(item?.name || item?.label || ''),
      count: Number(item?.count || 0),
      colorIndex: item?.colorIndex ?? item?.colorId ?? item?.color ?? null,
    }));
  });
}

async function createLabelOnce(client, target) {
  return client.page.evaluate(async ({ name, requestedHex }) => {
    const WPP = window.WPP || null;
    if (!WPP?.labels?.getAllLabels || !WPP?.lists?.create) {
      return { ok: false, reason: 'CREATE_LABEL_API_UNAVAILABLE' };
    }

    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const serializedId = (value) => String(
      value?._serialized
      || value?.id?._serialized
      || value?.id
      || value?.labelId
      || value
      || ''
    ).trim();
    const toRgb = (hex) => {
      const clean = String(hex || '').replace('#', '');
      if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
      return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
      ];
    };

    const beforeRaw = await WPP.labels.getAllLabels();
    const before = Array.isArray(beforeRaw) ? beforeRaw : Object.values(beforeRaw || {});
    const existing = before.find((item) => normalize(item?.name || item?.label) === normalize(name));
    if (existing) {
      return { ok: true, created: false, id: serializedId(existing), name: String(existing?.name || name) };
    }

    let palette = [];
    try {
      const rawPalette = WPP.labels.getLabelColorPalette
        ? await WPP.labels.getLabelColorPalette()
        : [];
      palette = Array.isArray(rawPalette) ? rawPalette : Object.values(rawPalette || {});
    } catch (_) {}

    const wanted = toRgb(requestedHex);
    let colorIndex = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    palette.forEach((entry, index) => {
      const hex = typeof entry === 'string'
        ? entry
        : entry?.hex || entry?.hexColor || entry?.color || entry?.value;
      const candidate = toRgb(hex);
      if (!wanted || !candidate) return;
      const distance = ((candidate[0] - wanted[0]) ** 2)
        + ((candidate[1] - wanted[1]) ** 2)
        + ((candidate[2] - wanted[2]) ** 2);
      if (distance < bestDistance) {
        bestDistance = distance;
        colorIndex = index;
      }
    });

    try {
      const rawId = await WPP.lists.create(name, [], Number.isInteger(colorIndex) ? colorIndex : undefined);
      const id = serializedId(rawId);
      return { ok: Boolean(id), created: true, id, name, colorIndex };
    } catch (error) {
      return {
        ok: false,
        created: false,
        reason: String(error?.message || error?.text || error || 'CREATE_FAILED'),
      };
    }
  }, {
    name: String(target.name || '').trim(),
    requestedHex: desiredHex(target.color),
  });
}

async function ensureRequiredLabelsOnce(channel) {
  if (!env.enableContactLabels || !channel?.client) return false;

  const client = channel.client;
  const targets = requiredTargets();
  console.log(`[LISTAS][INÍCIO] conferindo ${targets.length} etiquetas obrigatórias uma única vez...`);

  let allReady = true;
  for (const target of targets) {
    try {
      const labels = await readLabels(client);
      const matches = labels.filter((item) => normalizeName(item.name) === normalizeName(target.name));

      if (matches.length) {
        const chosen = [...matches].sort((a, b) => Number(b.count || 0) - Number(a.count || 0))[0];
        console.log(
          `[LISTAS][INÍCIO] existente | tipo=${target.type} | nome="${target.name}" `
          + `| ID=${chosen.id} | quantidade=${matches.length}`,
        );
        continue;
      }

      const created = await createLabelOnce(client, target);
      if (!created?.ok) {
        allReady = false;
        console.error(
          `[LISTAS][INÍCIO] falha ao criar | tipo=${target.type} | nome="${target.name}" `
          + `| motivo=${created?.reason || 'sem retorno'}`,
        );
        continue;
      }

      console.log(
        `[LISTAS][INÍCIO] criada | tipo=${target.type} | nome="${target.name}" `
        + `| ID=${created.id || '-'} | cor=${target.color}`,
      );

      // Espera apenas a sincronização visual. Nunca cria novamente nesta inicialização.
      await wait(900);
    } catch (error) {
      allReady = false;
      console.error(
        `[LISTAS][INÍCIO] erro isolado | tipo=${target.type} | nome="${target.name}" | `,
        error?.stack || error?.message || error,
      );
    }
  }

  try {
    const finalLabels = await readLabels(client);
    const summary = targets.map((target) => {
      const count = finalLabels.filter((item) => normalizeName(item.name) === normalizeName(target.name)).length;
      return `${target.name}=${count}`;
    });
    console.log(`[LISTAS][INÍCIO] resumo final | ${summary.join(' | ')}`);
  } catch (error) {
    console.warn('[LISTAS][INÍCIO] não foi possível gerar o resumo final:', error?.message || error);
  }

  return allReady;
}

module.exports = {
  ensureRequiredLabelsOnce,
  _test: { normalizeName, requiredTargets },
};
