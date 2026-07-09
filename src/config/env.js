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
  if (raw === undefined || raw === null) return fallback;
  if (String(raw).trim() === '') return [];
  return String(raw)
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapList(name) {
  const raw = process.env[name];
  if (!raw) return {};
  return String(raw)
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const [key, value] = item.split('=').map((part) => String(part || '').trim());
      if (key && value) acc[key.toLowerCase()] = value;
      return acc;
    }, {});
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
  // Whitelist temporária de teste: vazio = atende qualquer contato.
  allowedClientNumbers: list('ALLOWED_CLIENT_NUMBERS', []),
  allowedChatIds: list('ALLOWED_CHAT_IDS', []),
  // Mapeamento manual quando o WhatsApp só entrega @lid e não expõe o telefone.
  // Ex: 18885055098907@lid=31971386091
  lidNumberMap: mapList('LID_NUMBER_MAP'),
  assetsDir: process.env.ASSETS_DIR || 'assets',
  mostruarioLetreiroImageBaseName: process.env.MOSTRUARIO_LETREIRO_IMAGE_BASENAME || 'Mostruario_Letreiro',
  mostruarioLetreiroPdfPath: process.env.MOSTRUARIO_LETREIRO_PDF_PATH || '',
  mostruarioLetreiroPdfUrl: process.env.MOSTRUARIO_LETREIRO_PDF_URL || '',
};

if (env.maxReplyDelayMs < env.minReplyDelayMs) {
  env.maxReplyDelayMs = env.minReplyDelayMs;
}

module.exports = { env };
