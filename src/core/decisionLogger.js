'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { maskText } = require('./safeLoggingPreload');

const CATEGORIES = Object.freeze([
  'ENTRADA',
  'IDENTIDADE',
  'RECUPERAÇÃO',
  'HANDOFF',
  'BUFFER',
  'FILA',
  'FLUXO',
  'ENVIO',
  'ETIQUETA',
  'NOTA',
  'ADMIN',
  'CONEXÃO',
  'ERRO',
]);

const categorySet = new Set(CATEGORIES);
const context = new AsyncLocalStorage();
const ANSI = Object.freeze({
  reset: '\u001b[0m',
  pink: '\u001b[38;5;205m',
  purple: '\u001b[38;5;141m',
  white: '\u001b[97m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
});

function colorsEnabled() {
  return Boolean(process.stdout?.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb');
}

function cleanText(value, max = 160) {
  return maskText(String(value ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function shortMessageId(value) {
  const raw = typeof value === 'object'
    ? value?.id?._serialized || value?.id || value?.messageId || value?.key?.id
      || `${value?.from || value?.chatId || ''}:${value?.body || value?.text || value?.caption || ''}:${value?.timestamp || ''}`
    : value;
  const text = String(raw || '').trim();
  if (!text) return '----';
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 4).toUpperCase();
}

function normalizeContext(input = {}) {
  return {
    chat: cleanText(input.chat || input.clientId || '', 80) || undefined,
    msg: cleanText(input.msg || input.messageId || '', 16) || undefined,
    etapa: cleanText(input.etapa || input.stage || '', 80) || undefined,
  };
}

function run(input, fn) {
  const merged = { ...normalizeContext(context.getStore()), ...normalizeContext(input) };
  return context.run(merged, fn);
}

function current() {
  return normalizeContext(context.getStore());
}

function formatValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (value instanceof Error) return JSON.stringify(cleanText(value.message || value, 220));
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_) { return JSON.stringify(cleanText(value, 220)); }
  }
  const text = cleanText(value, 220);
  return /[\s·="]/.test(text) ? JSON.stringify(text) : text;
}

function plainLine(category, event, fields = {}) {
  const selected = categorySet.has(category) ? category : 'ERRO';
  const merged = { ...current(), ...normalizeContext(fields), ...fields };
  delete merged.clientId;
  delete merged.messageId;
  delete merged.stage;
  const ordered = {};
  for (const key of ['chat', 'msg', 'etapa']) {
    if (merged[key] !== undefined && merged[key] !== '') ordered[key] = merged[key];
    delete merged[key];
  }
  if (event) ordered.evento = event;
  Object.assign(ordered, merged);
  return [selected, ...Object.entries(ordered).map(([key, value]) => `${key}=${formatValue(value)}`)].join(' · ');
}

function colorize(line) {
  if (!colorsEnabled()) return line;
  const parts = line.split(' · ');
  return parts.map((part, index) => {
    if (index === 0) return `${ANSI.bold}${ANSI.pink}${part}${ANSI.reset}`;
    const equal = part.indexOf('=');
    if (equal < 0) return `${ANSI.white}${part}${ANSI.reset}`;
    return `${ANSI.purple}${part.slice(0, equal)}=${ANSI.white}${part.slice(equal + 1)}${ANSI.reset}`;
  }).join(`${ANSI.dim} · ${ANSI.reset}`);
}

function log(category, event, fields = {}, level = 'log') {
  try {
    const line = colorize(plainLine(category, event, fields));
    const method = ['warn', 'error', 'info'].includes(level) ? level : 'log';
    console[method](line);
    return line;
  } catch (error) {
    console.error(`ERRO · evento=falha_no_logger · motivo=${cleanText(error?.message || error)}`);
    return null;
  }
}

module.exports = {
  CATEGORIES,
  cleanText,
  current,
  log,
  plainLine,
  run,
  shortMessageId,
};
