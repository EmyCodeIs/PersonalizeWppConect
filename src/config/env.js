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

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return String(raw)
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const env = {
  sessionName: process.env.WPP_SESSION_NAME || 'personalize-wppconnect',
  mockMode: bool('MOCK_MODE', false),
  // false por padrão para abrir uma janela visível do Chrome/WhatsApp Web no teste real.
  wppHeadless: bool('WPP_HEADLESS', false),
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
  enableUnreadBootstrap: bool('ENABLE_UNREAD_BOOTSTRAP', true),
  unreadBootstrapDelayMs: Math.max(1000, num('UNREAD_BOOTSTRAP_DELAY_MS', 6000)),
  unreadBootstrapMaxChats: Math.max(1, num('UNREAD_BOOTSTRAP_MAX_CHATS', 30)),
  unreadBootstrapMaxMessagesPerChat: Math.max(1, num('UNREAD_BOOTSTRAP_MAX_MESSAGES_PER_CHAT', 8)),
  // Whitelist temporária de teste: vazio = atende qualquer contato. Durante teste, use só seu número.
  allowedClientNumbers: list('ALLOWED_CLIENT_NUMBERS', ['31971386091']),
  allowedChatIds: list('ALLOWED_CHAT_IDS', []),
};

if (env.maxReplyDelayMs < env.minReplyDelayMs) {
  env.maxReplyDelayMs = env.minReplyDelayMs;
}

module.exports = { env };
