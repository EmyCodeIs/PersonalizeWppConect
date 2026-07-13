'use strict';

const { ensureRequiredCatalog, getServiceLabel } = require('./serviceLabels');

async function ensureLetreiroPurpleLabel(channel) {
  const definition = getServiceLabel('letreiro');
  const result = await ensureRequiredCatalog(channel, { definitions: [definition] });
  const entry = result?.catalog?.[definition.key] || null;

  const response = {
    ready: Boolean(result?.ready && entry),
    id: entry?.id || null,
    name: entry?.name || definition.name,
    colorIndex: entry?.colorIndex ?? null,
    expectedColorIndex: entry?.expectedColorIndex ?? null,
    duplicateIds: entry?.duplicateIds || [],
    missing: result?.missing || [],
    colorMismatches: result?.colorMismatches || [],
  };

  console.log(
    `[ETIQUETAS] cor de "${definition.name}": pronta=${String(response.ready)} `
    + `canônica=${response.id || '-'} índice=${String(response.colorIndex ?? '-')} `
    + `esperado=${String(response.expectedColorIndex ?? '-')} `
    + `duplicadas=${response.duplicateIds.join(',') || '-'}`,
  );

  return response;
}

module.exports = {
  ensureLetreiroPurpleLabel,
};
