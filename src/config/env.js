'use strict';

require('dotenv').config();

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const env = {
  sessionName: process.env.WPP_SESSION_NAME || 'personalize-wppconnect',
  mockMode: bool('MOCK_MODE', false),
  businessName: process.env.BUSINESS_NAME || 'Personalize',
  sellerName: process.env.SELLER_NAME || 'Vendedor Personalize',
  bufferMs: Math.max(1000, num('BUFFER_MS', 4500)),
  minReplyDelayMs: Math.max(0, num('MIN_REPLY_DELAY_MS', 1800)),
  maxReplyDelayMs: Math.max(0, num('MAX_REPLY_DELAY_MS', 4200)),
  stopNonLetteringFlow: bool('STOP_NON_LETTERING_FLOW', true),
  enableContactNotes: bool('ENABLE_CONTACT_NOTES', true),
  enableContactLabels: bool('ENABLE_CONTACT_LABELS', true),
  awaitingQuoteLabelName: process.env.AWAITING_QUOTE_LABEL_NAME || 'Aguardando orçamento',
  awaitingQuoteLabelColor: process.env.AWAITING_QUOTE_LABEL_COLOR || 'green',
};

if (env.maxReplyDelayMs < env.minReplyDelayMs) {
  env.maxReplyDelayMs = env.minReplyDelayMs;
}

module.exports = { env };
