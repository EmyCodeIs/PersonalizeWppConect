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
  if (!cleanIds.length) return { ok: true, deletedIds: [], failures: [] };

  const client = channel?.client;
  if (!client?.page?.evaluate) {
    return {
      ok: false,
      deletedIds: [],
      failures: cleanIds.map((id) => ({ id, reason: 'page_unavailable' })),
      reason: 'page_unavailable',
    };
  }

  const deletedIds = [];
  const failures = [];

  for (const id of cleanIds) {
    let browserResult = null;
    try {
      browserResult = await client.page.evaluate(async ({ id: rawId }) => {
        const WPP = window.WPP || null;
        const id = String(rawId || '').trim();
        const errorText = (err) => {
          if (typeof err === 'string') return err;
          if (err?.message) return String(err.message);
          if (err?.text) return String(err.text);
          try {
            const serialized = JSON.stringify(err);
            if (serialized && serialized !== '{}') return serialized;
          } catch (_) {}
          return String(err || 'erro desconhecido');
        };
        const getLabels = async () => {
          const value = await WPP.labels.getAllLabels();
          return Array.isArray(value) ? value : Object.values(value || {});
        };
        const labelId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || '');
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        if (!WPP?.labels?.getAllLabels) {
          return { submitted: false, deleted: false, reason: 'labels_api_unavailable' };
        }

        const before = await getLabels();
        const original = before.find((item) => labelId(item) === id) || null;
        if (!original) {
          return { submitted: true, deleted: true, alreadyAbsent: true, id };
        }

        const errors = [];
        let submitted = false;

        if (typeof WPP.labels.deleteLabel === 'function') {
          try {
            await WPP.labels.deleteLabel([id]);
            submitted = true;
          } catch (err) {
            errors.push(`public:${errorText(err)}`);
          }
        } else {
          errors.push('public:delete_api_unavailable');
        }

        await sleep(700);
        let after = await getLabels();
        if (!after.some((item) => labelId(item) === id)) {
          return { submitted: true, deleted: true, id, errors };
        }

        const labelStore = WPP?.whatsapp?.LabelStore
          || window.Store?.Label
          || window.Store?.Labels
          || null;
        const deleteAction = WPP?.whatsapp?.functions?.labelDeleteAction || null;
        const label = labelStore?.get?.(id) || original;

        if (typeof deleteAction === 'function' && label) {
          try {
            await deleteAction(
              id,
              String(label?.name || label?.label || ''),
              Number(label?.colorIndex ?? label?.colorId ?? label?.color ?? 0),
            );
            submitted = true;
          } catch (err) {
            errors.push(`fallback:${errorText(err)}`);
          }
        } else {
          errors.push('fallback:internal_delete_unavailable');
        }

        await sleep(700);
        after = await getLabels();
        const deleted = !after.some((item) => labelId(item) === id);
        return {
          submitted,
          deleted,
          id,
          errors,
          reason: deleted ? null : errors.join(' | ') || 'label_still_exists',
        };
      }, { id });
    } catch (err) {
      browserResult = {
        submitted: false,
        deleted: false,
        reason: err?.stack || err?.message || String(err || 'delete_evaluate_error'),
      };
    }

    await wait(350);
    const verified = await readLabelSnapshot(channel);
    const stillExists = verified.available
      ? verified.items.some((item) => String(item.id) === id)
      : !browserResult?.deleted;

    if (!stillExists) {
      deletedIds.push(id);
      console.log(`[LISTAS][REPARO] etiqueta duplicada removida | ID=${id}`);
    } else {
      const reason = browserResult?.reason
        || browserResult?.errors?.join(' | ')
        || 'etiqueta continua existindo após a exclusão';
      failures.push({ id, reason });
      console.warn(`[LISTAS][REPARO] exclusão não confirmada | ID=${id} | motivo=${reason}`);
    }
  }

  return {
    ok: failures.length === 0,
    deletedIds,
    failures,
    reason: failures.length ? 'partial_delete' : null,
  };
}

async function repairDuplicateLabels(channel, snapshot = null) {
  const current = snapshot || await readLabelSnapshot(channel);
  if (!current.available) {
    return { ok: false, repaired: 0, deletedIds: [], failures: [], reason: current.reason || 'snapshot_unavailable' };
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
      `[LISTAS][REPARO] duplicata encontrada | tipo=${target.type} | nome="${target.name}" `
      + `| manter=${canonical.id} | remover=${ids.join(',')}`,
    );

    const result = await deleteManagedLabels(channel, ids);
    if (result.deletedIds?.length) {
      repaired += 1;
      deletedIds.push(...result.deletedIds);
    }
    if (result.failures?.length) {
      failures.push({
        target,
        ids: result.failures.map((item) => item.id),
        reason: result.failures.map((item) => `${item.id}:${item.reason}`).join(' | '),
      });
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
    console.warn(`${prefix} ATENÇÃO: ${issue.message}`);
    if (issue.matches?.length) {
      console.warn(`${prefix} IDs encontrados: ${issue.matches.map((item) => item.id || '-').join(', ')}`);
    }
  }
  console.log(`${prefix} resultado: ${report.ready ? 'ETIQUETAS OK' : 'ETIQUETAS COM PENDÊNCIA — atendimento continua ativo'}`);
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
