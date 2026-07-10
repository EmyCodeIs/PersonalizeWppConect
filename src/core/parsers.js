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

// Port direto da regra de medida inteligente do projeto Personalize em produção.
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

  const removeOne = (arr, val) => {
    const idx = arr.indexOf(val);
    if (idx >= 0) arr.splice(idx, 1);
  };

  const extractNums = (str) => {
    const nums = [];
    const re = /\d+(?:[.,]\d+)?/g;
    let m;
    while ((m = re.exec(str))) {
      const token = m[0];
      const start = m.index;
      const end = start + token.length;
      const prev = str[start - 1] || '';
      const next = str[end] || '';
      if (/[a-z]/i.test(prev) || /[a-z]/i.test(next)) continue;
      const n = normalizeNumberToken(token);
      if (n !== null) nums.push(n);
    }
    return nums;
  };

  const clampOk = (n) => Number.isFinite(n) && n > 0 && n <= 10000;

  const mx = lowered.match(/(\d+(?:[.,]\d+)?)\s*(?:x|×|por|\*|-|\/)\s*(\d+(?:[.,]\d+)?)/);
  if (mx?.[1] && mx?.[2]) {
    const l = normalizeNumberToken(mx[1]);
    const a = normalizeNumberToken(mx[2]);
    if (clampOk(l)) out.largura = l;
    if (clampOk(a)) out.altura = a;
    if (out.largura !== null && out.altura !== null) {
      out.modo = 'completo';
      return out;
    }
  }

  const usados = [];
  const mh1 = lowered.match(/altura\D{0,12}(\d+(?:[.,]\d+)?)/);
  const mh2 = lowered.match(/(\d+(?:[.,]\d+)?)(?:\s*(?:cm|mm|m))?\s*(?:de\s*)?altura/);
  const mh = mh1?.[1] || mh2?.[1];
  if (mh) {
    const a = normalizeNumberToken(mh);
    if (clampOk(a)) {
      out.altura = a;
      usados.push(a);
    }
  }

  const mw1 = lowered.match(/(largura|comprimento|cumprimento)\D{0,12}(\d+(?:[.,]\d+)?)/);
  const mw2 = lowered.match(/(\d+(?:[.,]\d+)?)(?:\s*(?:cm|mm|m))?\s*(?:de\s*)?(largura|comprimento|cumprimento)/);
  const mw = mw1?.[2] || mw2?.[1];
  if (mw) {
    const l = normalizeNumberToken(mw);
    if (clampOk(l)) {
      out.largura = l;
      usados.push(l);
    }
  }

  const nums = extractNums(lowered);
  const restantes = [...nums];
  for (const u of usados) removeOne(restantes, u);

  if (out.largura === null && restantes.length) {
    const n = restantes.shift();
    if (clampOk(n)) out.largura = n;
  }
  if (out.altura === null && restantes.length) {
    const n = restantes.shift();
    if (clampOk(n)) out.altura = n;
  }

  if (clampOk(out.largura) && clampOk(out.altura)) {
    out.modo = 'completo';
    return out;
  }
  if (clampOk(out.largura) && !clampOk(out.altura)) {
    out.altura = null;
    out.modo = 'largura';
    return out;
  }
  if (!clampOk(out.largura) && clampOk(out.altura)) {
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
