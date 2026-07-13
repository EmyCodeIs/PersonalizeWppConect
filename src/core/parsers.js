'use strict';

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPhone(text) {
  const raw = String(text || '');
  const match = raw.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}/);
  if (!match) return null;
  const digits = onlyDigits(match[0]);
  return digits.length >= 10 && digits.length <= 13 ? digits : null;
}

function extractName(text) {
  const raw = String(text || '').trim();
  const patterns = [
    /(?:meu nome e|meu nome é|me chamo|sou a?|aqui e|aqui é|eu sou)\s+([a-zA-ZÀ-ÿ\s]{2,60})/i,
    /(?:nome[:\-])\s*([a-zA-ZÀ-ÿ\s]{2,60})/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return titleCase(match[1].replace(/\b(?:telefone|tel|numero|número).*$/i, '').trim());
  }
  return null;
}

function titleCase(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (['de', 'da', 'do', 'das', 'dos'].includes(normalizeText(lower))) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function normalizeNumberToken(token) {
  const s = String(token || '').replace(',', '.');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Coleta inteligente baseada no fluxo oficial da Personalize.
// Além das formas já aceitas em produção, corrige a ambiguidade de frases como
// "100 de largura e 20 de altura" e normaliza metros/milímetros para cm.
function parseMedidasFromText(input, parcial = {}) {
  const raw = String(input || '').trim();
  const lowered = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const out = {
    largura: parcial?.largura ?? null,
    altura: parcial?.altura ?? null,
    modo: 'invalido',
    descricao: null,
  };

  if (!raw) return out;

  if (/\b(nao\s*sei|n\s*sei|sem\s*medida|nao\s*tenho|nao\s*tenho\s*certeza)\b/.test(lowered)) {
    out.modo = 'pedir_descricao';
    return out;
  }

  const descricaoTriggers = /\b(a4|folha|porta|parede|proporcional|aproximad|mais\s*ou\s*menos|grande|pequeno|tamanho)\b/.test(lowered);
  const clampOk = (n) => Number.isFinite(n) && n > 0 && n <= 10000;
  const labelKind = (value) => /altura/.test(value) ? 'altura' : 'largura';
  const unitPattern = '(?:mm|milimetros?|cm|centimetros?|m|metros?)';

  const valueInCm = (token, unit = '') => {
    const value = normalizeNumberToken(token);
    if (!Number.isFinite(value)) return null;
    const normalizedUnit = String(unit || '').trim().toLowerCase();
    if (/^(?:m|metros?)$/.test(normalizedUnit)) return value * 100;
    if (/^(?:mm|milimetros?)$/.test(normalizedUnit)) return value / 10;
    return value;
  };

  const assign = (kind, token, unit = '') => {
    const value = valueInCm(token, unit);
    if (!clampOk(value)) return false;
    out[kind] = value;
    return true;
  };

  // Faixas são preservadas como referência, em vez de transformar
  // "80-120 por 20-30" acidentalmente em 80 x 120.
  const rangePattern = new RegExp(`\\d+(?:[.,]\\d+)?\\s*(?:-|a|ate)\\s*\\d+(?:[.,]\\d+)?\\s*${unitPattern}?`, 'i');
  if (rangePattern.test(lowered)) {
    out.modo = 'descricao';
    out.descricao = raw;
    out.largura = null;
    out.altura = null;
    return out;
  }

  // Forma direta: 100x20, 1m x 20cm, 100 por 20.
  const pair = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern})?\\s*(?:x|×|por|\\*)\\s*`
      + `(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern})?`,
    'i',
  ).exec(lowered);
  if (pair) {
    assign('largura', pair[1], pair[2]);
    assign('altura', pair[3], pair[4]);
    if (clampOk(out.largura) && clampOk(out.altura)) {
      out.modo = 'completo';
      return out;
    }
  }

  const captures = [];
  const label = '(altura|largura|comprimento|cumprimento)';

  // "largura 100", "altura: 20cm". O separador é restrito para não
  // capturar o número pertencente ao outro rótulo da frase.
  const labelBefore = new RegExp(
    `\\b${label}\\b\\s*(?:(?:de|com)\\s*)?(?:[:=]\\s*)?`
      + `(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern})?`,
    'gi',
  );
  let match;
  while ((match = labelBefore.exec(lowered))) {
    captures.push({
      index: match.index,
      kind: labelKind(match[1]),
      token: match[2],
      unit: match[3],
      source: 'label-before',
    });
  }

  // "100 de largura", "20cm de altura".
  const numberBefore = new RegExp(
    `(\\d+(?:[.,]\\d+)?)\\s*(${unitPattern})?\\s*(?:de\\s*)?\\b${label}\\b`,
    'gi',
  );
  while ((match = numberBefore.exec(lowered))) {
    captures.push({
      index: match.index,
      kind: labelKind(match[3]),
      token: match[1],
      unit: match[2],
      source: 'number-before',
    });
  }

  captures.sort((a, b) => a.index - b.index);
  const labelBeforeKinds = new Set(
    captures.filter((item) => item.source === 'label-before').map((item) => item.kind),
  );
  const numberBeforeKinds = new Set(
    captures.filter((item) => item.source === 'number-before').map((item) => item.kind),
  );
  const preferredSource = labelBeforeKinds.size === 2
    ? 'label-before'
    : numberBeforeKinds.size === 2
      ? 'number-before'
      : null;
  for (const kind of ['largura', 'altura']) {
    const candidates = captures.filter((item) => item.kind === kind);
    const chosen = preferredSource
      ? (candidates.find((item) => item.source === preferredSource) || candidates[0])
      : (candidates.find((item) => item.source === 'number-before') || candidates[0]);
    if (chosen) assign(chosen.kind, chosen.token, chosen.unit);
  }

  // Quando faltam rótulos, usa os números restantes na ordem natural.
  // Ignora A4, 24h e outros números grudados em letras não reconhecidas.
  const generic = new RegExp(`\\d+(?:[.,]\\d+)?(?:\\s*${unitPattern})?`, 'gi');
  const numbers = [];
  while ((match = generic.exec(lowered))) {
    const tokenText = match[0];
    const start = match.index;
    const endIndex = start + tokenText.length;
    const prev = lowered[start - 1] || '';
    const next = lowered[endIndex] || '';
    if (/[a-z]/i.test(prev) || /[a-z]/i.test(next)) continue;

    const parsed = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(tokenText.trim());
    if (!parsed) continue;
    const value = valueInCm(parsed[1], parsed[2]);
    if (!clampOk(value)) continue;
    if (!numbers.some((entry) => entry.index === start)) numbers.push({ index: start, value });
  }

  // Remove os números já associados explicitamente aos rótulos.
  const usedValues = captures
    .map((item) => valueInCm(item.token, item.unit))
    .filter(clampOk);
  const remaining = numbers.map((item) => item.value);
  for (const used of usedValues) {
    const index = remaining.indexOf(used);
    if (index >= 0) remaining.splice(index, 1);
  }

  if (!clampOk(out.largura) && remaining.length) out.largura = remaining.shift();
  if (!clampOk(out.altura) && remaining.length) out.altura = remaining.shift();

  if (clampOk(out.largura) && clampOk(out.altura)) {
    out.modo = 'completo';
    return out;
  }
  if (clampOk(out.largura)) {
    out.altura = null;
    out.modo = 'largura';
    return out;
  }
  if (clampOk(out.altura)) {
    out.largura = null;
    out.modo = 'altura';
    return out;
  }

  if (descricaoTriggers || raw.length >= 6) {
    out.modo = 'descricao';
    out.descricao = raw;
    out.largura = null;
    out.altura = null;
    return out;
  }

  out.modo = 'pedir_descricao';
  return out;
}

function parseMeasure(text) {
  const parsed = parseMedidasFromText(text, { largura: null, altura: null });
  if (parsed.modo === 'invalido' || parsed.modo === 'pedir_descricao') return null;
  return {
    largura: parsed.largura,
    altura: parsed.altura,
    descricao: parsed.descricao || (
      parsed.modo === 'completo'
        ? `${parsed.largura} x ${parsed.altura} cm`
        : parsed.modo === 'largura'
          ? `${parsed.largura} cm de largura`
          : parsed.modo === 'altura'
            ? `${parsed.altura} cm de altura`
            : String(text || '').trim()
    ),
    complete: parsed.modo === 'completo',
    modo: parsed.modo,
  };
}

function splitColors(text) {
  return String(text || '')
    .split(/[,;\/|+]|\se\s/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  onlyDigits,
  normalizeText,
  extractPhone,
  extractName,
  parseMeasure,
  parseMedidasFromText,
  normalizeNumberToken,
  splitColors,
  titleCase,
};
