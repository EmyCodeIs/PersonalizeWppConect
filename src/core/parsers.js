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
    /(?:meu nome e|me chamo|sou a?|aqui e|eu sou)\s+([a-zA-ZÀ-ÿ\s]{2,60})/i,
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

function parseMeasure(text) {
  const raw = normalizeText(text).replace(',', '.');
  const pair = raw.match(/(\d+(?:\.\d+)?)\s*(?:x|por|\*)\s*(\d+(?:\.\d+)?)/i);
  if (pair) return { largura: Number(pair[1]), altura: Number(pair[2]), descricao: `${pair[1]} x ${pair[2]} cm`, complete: true };
  const width = raw.match(/(?:largura|larg|com)\s*(?:de)?\s*(\d+(?:\.\d+)?)/i) || raw.match(/^(\d+(?:\.\d+)?)\s*(?:cm)?$/i);
  if (width) return { largura: Number(width[1]), altura: null, descricao: `${width[1]} cm de largura`, complete: false };
  if (raw.length >= 3) return { largura: null, altura: null, descricao: String(text || '').trim(), complete: false };
  return null;
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
  splitColors,
  titleCase,
};
