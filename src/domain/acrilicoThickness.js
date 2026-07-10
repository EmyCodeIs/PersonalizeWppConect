'use strict';

function normalizeColorLabel(cor) {
  return String(cor || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MIRROR_COLOR_ALIASES = new Set([
  'dourado',
  'prata',
  'rose',
  'vermelho espelhado',
  'verde espelhado',
  'azul espelhado',
  'roxo espelhado',
  'espelhado vermelho',
  'espelhado verde',
  'espelhado azul',
  'espelhado roxo',
]);

function isMirrorColor(cor) {
  const label = normalizeColorLabel(cor);
  if (!label) return false;
  if (label.includes('espelhado')) return true;
  return MIRROR_COLOR_ALIASES.has(label);
}

function getBaseMmForColor(cor) {
  return isMirrorColor(cor) ? 2 : 3;
}

function normalizeColors(cores) {
  return (Array.isArray(cores) ? cores : [cores])
    .map((cor) => String(cor || '').trim())
    .filter(Boolean);
}

function listToPt(items) {
  const arr = (items || []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!arr.length) return '';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} e ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')} e ${arr[arr.length - 1]}`;
}

function groupColorsByBaseMm(cores) {
  const groups = { 3: [], 2: [] };
  for (const cor of normalizeColors(cores)) {
    groups[getBaseMmForColor(cor)].push(cor);
  }
  return groups;
}

function buildThicknessPart(colors, mm) {
  const list = listToPt(colors);
  if (!list) return '';
  const prefix = colors.length === 1 ? 'a cor' : 'as cores';
  const verb = colors.length === 1 ? 'possui' : 'possuem';
  return `${prefix} ${list} ${verb} espessura padrão de ${mm}mm`;
}

function buildBaseThicknessMessage(cores) {
  const groups = groupColorsByBaseMm(cores);
  const parts = [];
  if (groups[3].length) parts.push(buildThicknessPart(groups[3], 3));
  if (groups[2].length) parts.push(buildThicknessPart(groups[2], 2));
  if (!parts.length) return '🔎 Observação: as cores escolhidas possuem espessura padrão conforme catálogo.';
  return `🔎 Observação: ${parts.join(' e ')}.`;
}

function buildBaseThicknessLabel(cores) {
  const groups = groupColorsByBaseMm(cores);
  if (groups[3].length && groups[2].length) return '3mm e 2mm';
  if (groups[2].length) return '2mm';
  return '3mm';
}

function buildKeepBaseTitle(cores) {
  return `Quero manter ${buildBaseThicknessLabel(cores)}`;
}

function buildKeepBaseDescription(cores) {
  const groups = groupColorsByBaseMm(cores);
  if (groups[3].length && groups[2].length) return 'Sólidas 3mm e espelhadas 2mm';
  if (groups[2].length) return 'Seguir com a espessura padrão 2mm';
  return 'Seguir com a espessura padrão 3mm';
}

function parseExtraMm(extra) {
  const n = Number(String(extra || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function buildExtraThicknessMessage(cores, extra) {
  const extraMm = parseExtraMm(extra);
  const groups = groupColorsByBaseMm(cores);
  const parts = [];
  if (groups[3].length) {
    parts.push(`o acrílico ${listToPt(groups[3])} com acréscimo em acrílico cristal de ${extraMm}mm ficará com ${3 + extraMm}mm de espessura`);
  }
  if (groups[2].length) {
    parts.push(`o acrílico ${listToPt(groups[2])} com acréscimo em acrílico cristal de ${extraMm}mm ficará com ${2 + extraMm}mm de espessura`);
  }
  if (!parts.length) return `Certo! Acréscimo em acrílico cristal de ${extraMm}mm anotado.`;
  const sentence = parts.join(', e ');
  return `Certo! ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function buildBaseThicknessSnapshot(cores) {
  return normalizeColors(cores).map((cor) => ({
    cor,
    tipo: isMirrorColor(cor) ? 'espelhada' : 'solida',
    baseMm: getBaseMmForColor(cor),
  }));
}

function getColorsFromContext(ctx = {}) {
  if (Array.isArray(ctx.coresSelecionadas) && ctx.coresSelecionadas.length) return ctx.coresSelecionadas;
  if (ctx.corUnica) return [ctx.corUnica];
  return [];
}

function ensureThicknessMetadata(target = {}) {
  const colors = getColorsFromContext(target);
  if (!colors.length) return target;
  target.espessuraBaseCores = buildBaseThicknessSnapshot(colors);
  target.espessuraBaseDescricao = buildBaseThicknessMessage(colors);
  target.espessuraBaseLabel = buildBaseThicknessLabel(colors);
  return target;
}

module.exports = {
  normalizeColorLabel,
  isMirrorColor,
  getBaseMmForColor,
  groupColorsByBaseMm,
  buildBaseThicknessMessage,
  buildBaseThicknessLabel,
  buildKeepBaseTitle,
  buildKeepBaseDescription,
  buildExtraThicknessMessage,
  buildBaseThicknessSnapshot,
  getColorsFromContext,
  ensureThicknessMetadata,
  listToPt,
};
