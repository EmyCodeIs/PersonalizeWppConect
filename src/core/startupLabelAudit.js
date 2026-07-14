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
  return COLOR_HEX[normalizeName(raw)] || null;
}

function paletteHex(entry) {
  const raw = typeof entry === 'string'
    ? entry
    : entry?.hex || entry?.hexColor || entry?.color || entry?.value;
  const value = String(raw || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
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
    const candidate = hexToRgb(paletteHex(entry));
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

function serviceTargets() {
  if (!env.enableContactLabels) return [];
  return [
    { type: 'serviço', name: env.serviceLabelLetreiro, color: env.serviceLabelLetreiroColor },
    { type: 'serviço', name: env.serviceLabelPlotagem, color: env.serviceLabelPlotagemColor },
    { type: 'serviço', name: env.serviceLabelOutros, color: env.serviceLabelOutrosColor },
  ].filter((item) => String(item.name || '').trim());
}

function sellerTargets() {
  if (!env.sellerLabelBlockingEnabled) return [];
  return Object.entries(env.sellerLabelRules || {})
    .map(([name, color]) => ({ type: 'vendedor', name, color }))
    .filter((item) => String(item.name || '').trim());
}

function managedTargets() {
  const seen = new Set();
  return [...serviceTargets(), ...sellerTargets()].filter((item) => {
    const key = `${item.type}:${normalizeName(item.name)}`;
    if (!normalizeName(item.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readLabelSnapshot(channel) {
  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return { available: false, items: [], palette: [], reason: 'page_unavailable' };
  }

  try {
    return await client.page.evaluate(async () => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels) {
        return { available: false, items: [], palette: [], reason: 'labels_api_unavailable' };
      }

      const value = await WPP.labels.getAllLabels();
      const labels = Array.isArray(value) ? value : Object.values(value || {});
      let palette = [];
      try {
        const rawPalette = WPP.labels.getLabelColorPalette
          ? await WPP.labels.getLabelColorPalette()
          : [];
        palette = Array.isArray(rawPalette) ? rawPalette : Object.values(rawPalette || {});
      } catch (_) {}

      return {
        available: true,
        reason: null,
        palette,
        items: labels.map((item) => ({
          id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
          name: String(item?.name || item?.label || ''),
          colorIndex: item?.colorIndex ?? item?.colorId ?? item?.color ?? null,
          hexColor: String(item?.hexColor || ''),
          count: Number(item?.count || 0),
        })),
      };
    });
  } catch (err) {
    return {
      available: false,
      items: [],
      palette: [],
      reason: String(err?.message || err || 'snapshot_error'),
    };
  }
}

function inspectTarget(snapshot, target, { requireColor = true } = {}) {
  const wantedName = normalizeName(target.name);
  const matches = (snapshot.items || []).filter((item) => normalizeName(item.name) === wantedName);
  const expectedHex = desiredHex(target.color);
  const expectedIndex = nearestPaletteIndex(snapshot.palette, expectedHex);

  if (!matches.length) {
    return {
      ok: false,
      blocking: true,
      code: 'missing',
      target,
      message: `${target.type} "${target.name}" não existe`,
      matches: [],
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      blocking: true,
      code: 'duplicate',
      target,
      message: `${target.type} "${target.name}" está duplicada (${matches.length})`,
      matches,
    };
  }

  const item = matches[0];
  const actualIndex = Number.isFinite(Number(item.colorIndex)) ? Number(item.colorIndex) : null;
  const actualHex = paletteHex(item.hexColor)
    || (Number.isInteger(actualIndex) ? paletteHex(snapshot.palette?.[actualIndex]) : null);

  let colorMatches = null;
  if (Number.isInteger(expectedIndex) && Number.isInteger(actualIndex)) {
    colorMatches = expectedIndex === actualIndex;
  } else if (expectedHex && actualHex) {
    colorMatches = expectedHex === actualHex;
  }

  if (colorMatches === false) {
    return {
      ok: false,
      blocking: true,
      code: 'wrong_color',
      target,
      item,
      expectedHex,
      expectedIndex,
      actualHex,
      actualIndex,
      message: `${target.type} "${target.name}" está com cor diferente da configurada (${target.color})`,
      matches,
    };
  }

  if (requireColor && colorMatches === null) {
    return {
      ok: false,
      blocking: true,
      code: 'color_unverified',
      target,
      item,
      expectedHex,
      expectedIndex,
      actualHex,
      actualIndex,
      message: `não foi possível confirmar a cor de ${target.type} "${target.name}"`,
      matches,
    };
  }

  return {
    ok: true,
    blocking: false,
    code: 'ok',
    target,
    item,
    expectedHex,
    expectedIndex,
    actualHex,
    actualIndex,
    matches,
  };
}

async function auditStartupLabels(channel, options = {}) {
  const snapshot = await readLabelSnapshot(channel);
  const targets = managedTargets();
  if (!snapshot.available) {
    return {
      ready: false,
      snapshot,
      results: [],
      issues: [{
        ok: false,
        blocking: true,
        code: 'labels_unavailable',
        message: `não foi possível consultar as listas do WhatsApp (${snapshot.reason || 'indisponível'})`,
      }],
    };
  }

  const results = targets.map((target) => inspectTarget(snapshot, target, options));
  const issues = results.filter((item) => item.blocking);
  return {
    ready: issues.length === 0,
    snapshot,
    results,
    issues,
  };
}

function logAuditReport(report, prefix = '[LISTAS][PRECHECK]') {
  if (!report) return;
  for (const result of report.results || []) {
    if (result.ok) {
      console.log(`${prefix} OK ${result.target.type}: ${result.target.name} | ID=${result.item?.id || '-'} | cor=${result.target.color}`);
    }
  }
  for (const issue of report.issues || []) {
    console.error(`${prefix} BLOQUEIO: ${issue.message}`);
    if (issue.matches?.length) {
      console.error(`${prefix} IDs encontrados: ${issue.matches.map((item) => item.id || '-').join(', ')}`);
    }
  }
  console.log(`${prefix} resultado: ${report.ready ? 'PRONTO PARA ATENDER' : 'ATENDIMENTO BLOQUEADO'}`);
}

module.exports = {
  auditStartupLabels,
  logAuditReport,
  managedTargets,
  _test: {
    desiredHex,
    inspectTarget,
    nearestPaletteIndex,
    normalizeName,
    paletteHex,
  },
};
