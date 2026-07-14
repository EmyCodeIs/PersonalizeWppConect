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

function itemColorStatus(snapshot, item, target) {
  const expectedHex = desiredHex(target.color);
  const expectedIndex = nearestPaletteIndex(snapshot.palette, expectedHex);
  const actualIndex = Number.isFinite(Number(item?.colorIndex)) ? Number(item.colorIndex) : null;
  const actualHex = paletteHex(item?.hexColor)
    || (Number.isInteger(actualIndex) ? paletteHex(snapshot.palette?.[actualIndex]) : null);

  let matches = null;
  if (Number.isInteger(expectedIndex) && Number.isInteger(actualIndex)) {
    matches = expectedIndex === actualIndex;
  } else if (expectedHex && actualHex) {
    matches = expectedHex === actualHex;
  }

  return { expectedHex, expectedIndex, actualHex, actualIndex, matches };
}

function compareIds(a, b) {
  const aId = String(a?.id || '');
  const bId = String(b?.id || '');
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function chooseCanonicalMatch(snapshot, target, matches = []) {
  return [...matches].sort((a, b) => {
    const colorA = itemColorStatus(snapshot, a, target).matches === true ? 1 : 0;
    const colorB = itemColorStatus(snapshot, b, target).matches === true ? 1 : 0;
    if (colorA !== colorB) return colorB - colorA;

    const exactA = String(a?.name || '').trim() === String(target?.name || '').trim() ? 1 : 0;
    const exactB = String(b?.name || '').trim() === String(target?.name || '').trim() ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;

    const countDifference = Number(b?.count || 0) - Number(a?.count || 0);
    if (countDifference) return countDifference;
    return compareIds(a, b);
  })[0] || null;
}

async function deleteManagedLabels(channel, ids = []) {
  const cleanIds = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!cleanIds.length) return { ok: true, deletedIds: [] };
  const client = channel?.client;
  if (!client?.page?.evaluate) return { ok: false, deletedIds: [], reason: 'page_unavailable' };

  try {
    const result = await client.page.evaluate(async ({ ids }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.deleteLabel) {
        return { ok: false, deletedIds: [], reason: 'delete_api_unavailable' };
      }

      const raw = await WPP.labels.deleteLabel(ids.length === 1 ? ids[0] : ids);
      const values = Array.isArray(raw) ? raw : [raw];
      const deletedIds = values
        .filter((item) => item?.deleteLabelResult === true)
        .map((item) => String(item?.id || ''));
      return {
        ok: deletedIds.length === ids.length,
        deletedIds,
        reason: deletedIds.length === ids.length ? null : 'partial_delete',
      };
    }, { ids: cleanIds });

    return result || { ok: false, deletedIds: [], reason: 'empty_delete_result' };
  } catch (err) {
    return { ok: false, deletedIds: [], reason: String(err?.message || err || 'delete_error') };
  }
}

async function repairDuplicateLabels(channel, snapshot = null) {
  const current = snapshot || await readLabelSnapshot(channel);
  if (!current.available) {
    return { ok: false, repaired: 0, deletedIds: [], reason: current.reason || 'snapshot_unavailable' };
  }

  let repaired = 0;
  const deletedIds = [];
  const failures = [];

  for (const target of managedTargets()) {
    const matches = (current.items || []).filter((item) => normalizeName(item.name) === normalizeName(target.name));
    if (matches.length <= 1) continue;

    const canonical = chooseCanonicalMatch(current, target, matches);
    const duplicates = matches.filter((item) => String(item.id) !== String(canonical?.id));
    const ids = duplicates.map((item) => String(item.id || '')).filter(Boolean);
    if (!canonical || !ids.length) continue;

    console.warn(
      `[LISTAS][REPARO] ${target.type} "${target.name}" duplicada. `
      + `Mantendo ID=${canonical.id} e removendo IDs=${ids.join(', ')}`,
    );

    const result = await deleteManagedLabels(channel, ids);
    if (result.ok) {
      repaired += 1;
      deletedIds.push(...result.deletedIds);
      await wait(900);
    } else {
      failures.push({ target, ids, reason: result.reason || 'delete_failed' });
      console.error(
        `[LISTAS][REPARO] falha ao remover duplicatas de "${target.name}": ${result.reason || 'erro desconhecido'}`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    repaired,
    deletedIds,
    failures,
  };
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
  const color = itemColorStatus(snapshot, item, target);

  if (color.matches === false) {
    return {
      ok: false,
      blocking: true,
      code: 'wrong_color',
      target,
      item,
      ...color,
      message: `${target.type} "${target.name}" está com cor diferente da configurada (${target.color})`,
      matches,
    };
  }

  if (requireColor && color.matches === null) {
    return {
      ok: false,
      blocking: true,
      code: 'color_unverified',
      target,
      item,
      ...color,
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
    ...color,
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
  deleteManagedLabels,
  logAuditReport,
  managedTargets,
  readLabelSnapshot,
  repairDuplicateLabels,
  _test: {
    chooseCanonicalMatch,
    desiredHex,
    inspectTarget,
    nearestPaletteIndex,
    normalizeName,
    paletteHex,
  },
};
