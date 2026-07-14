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

const serviceLabelLetreiro = process.env.SERVICE_LABEL_LETREIRO || 'Orçamento letreiro';
const serviceLabelPlotagem = process.env.SERVICE_LABEL_PLOTAGEM || 'Plotagens';
const serviceLabelOutros = process.env.SERVICE_LABEL_OUTROS || 'Outros';
const serviceLabelLetreiroColor = process.env.SERVICE_LABEL_LETREIRO_COLOR || 'purple';
const flowSessionTtlHours = Math.max(1, num('FLOW_SESSION_TTL_HOURS', 24));

const env = {
  sessionName: process.env.WPP_SESSION_NAME || 'personalize-wppconnect',
  mockMode: bool('MOCK_MODE', false),
  wppHeadless: bool('WPP_HEADLESS', false),
  enableTestCommands: bool('ENABLE_TEST_COMMANDS', true),
  businessName: process.env.BUSINESS_NAME || 'Personalize',
  sellerName: process.env.SELLER_NAME || 'Vendedor Personalize',

  // Memória curta do fluxo. Após o TTL, a conversa volta ao início.
  flowSessionTtlHours,
  completedSessionTtlHours: Math.max(1, num('COMPLETED_SESSION_TTL_HOURS', flowSessionTtlHours)),

  // Controle global de concorrência para evitar excesso de processamento simultâneo.
  maxConcurrentChats: Math.max(1, num('MAX_CONCURRENT_CHATS', 2)),
  maxQueueSize: Math.max(1, num('MAX_QUEUE_SIZE', 40)),
  chatProcessTimeoutMs: Math.max(5000, num('CHAT_PROCESS_TIMEOUT_MS', 45000)),

  // Entrada do cliente. O buffer curto atende respostas simples; o longo é usado
  // em medidas, arte, endereço, Pantone e observações com várias mensagens.
  bufferMs: Math.max(800, num('BUFFER_MS', 4500)),
  multiMessageBufferMs: Math.max(2500, num('MULTI_MESSAGE_BUFFER_MS', 8000)),
  measureBufferMs: Math.max(2500, num('MEASURE_BUFFER_MS', 8000)),
  artBufferMs: Math.max(2500, num('ART_BUFFER_MS', 8000)),
  addressBufferMs: Math.max(2500, num('ADDRESS_BUFFER_MS', 8000)),
  pantoneBufferMs: Math.max(2500, num('PANTONE_BUFFER_MS', 8000)),
  observationBufferMs: Math.max(2500, num('OBSERVATION_BUFFER_MS', 9000)),
  cityBufferMs: Math.max(800, num('CITY_BUFFER_MS', 2500)),
  interactiveBufferMs: Math.max(100, num('INTERACTIVE_BUFFER_MS', 350)),

  // Mantidos para respostas avulsas. Dentro de um grupo de resposta o sistema
  // ignora esses delays e envia os balões em sequência, sem pausas artificiais.
  minReplyDelayMs: Math.max(0, num('MIN_REPLY_DELAY_MS', 1800)),
  maxReplyDelayMs: Math.max(0, num('MAX_REPLY_DELAY_MS', 4200)),
  enableTyping: bool('ENABLE_TYPING', true),
  typingMinMs: Math.max(0, num('TYPING_MIN_MS', 650)),
  typingMaxMs: Math.max(0, num('TYPING_MAX_MS', 1600)),
  typingCharsPerSecond: Math.max(10, num('TYPING_CHARS_PER_SECOND', 45)),

  stopNonLetteringFlow: bool('STOP_NON_LETTERING_FLOW', true),
  enableContactNotes: bool('ENABLE_CONTACT_NOTES', true),
  enableContactLabels: bool('ENABLE_CONTACT_LABELS', true),
  detectManualContactLabels: bool('DETECT_MANUAL_CONTACT_LABELS', true),
  storeManualContactLabels: bool('STORE_MANUAL_CONTACT_LABELS', true),
  awaitingQuoteLabelName: process.env.AWAITING_QUOTE_LABEL_NAME || serviceLabelLetreiro,
  awaitingQuoteLabelColor: process.env.AWAITING_QUOTE_LABEL_COLOR || serviceLabelLetreiroColor,
  serviceLabelLetreiro,
  serviceLabelPlotagem,
  serviceLabelOutros,
  serviceLabelLetreiroColor,
  serviceLabelPlotagemColor: process.env.SERVICE_LABEL_PLOTAGEM_COLOR || 'gray',
  serviceLabelOutrosColor: process.env.SERVICE_LABEL_OUTROS_COLOR || 'red',
  serviceLabelReplaceGroup: list('SERVICE_LABEL_REPLACE_GROUP', [serviceLabelLetreiro, serviceLabelPlotagem, serviceLabelOutros]),
  enableUnreadBootstrap: bool('ENABLE_UNREAD_BOOTSTRAP', true),
  unreadBootstrapDelayMs: Math.max(1000, num('UNREAD_BOOTSTRAP_DELAY_MS', 6000)),
  unreadBootstrapMaxChats: Math.max(1, num('UNREAD_BOOTSTRAP_MAX_CHATS', 30)),
  unreadBootstrapMaxMessagesPerChat: Math.max(1, num('UNREAD_BOOTSTRAP_MAX_MESSAGES_PER_CHAT', 8)),
  allowedClientNumbers: list('ALLOWED_CLIENT_NUMBERS', []),
  allowedChatIds: list('ALLOWED_CHAT_IDS', []),
  lidNumberMap: mapList('LID_NUMBER_MAP'),
  assetsDir: process.env.ASSETS_DIR || 'assets',
  bemVindosImageBaseName: process.env.BEM_VINDOS_IMAGE_BASENAME || 'capa_bem_vindos',
  bemVindosLinkUrl: process.env.BEM_VINDOS_LINK_URL || 'https://personalizeseuambiente.com.br/bem-vindos',
  mostruarioLetreiroImageBaseName: process.env.MOSTRUARIO_LETREIRO_IMAGE_BASENAME || 'capa-mostruario',
  mostruarioLinkUrl:
    process.env.MOSTRUARIO_LINK_URL
    || process.env.MOSTRUARIO_LETREIRO_LINK_URL
    || 'https://personalizeseuambiente.com.br/mostruario-letreiros',
  assetTabelaCoresBaseName: process.env.ASSET_TABELA_CORES_BASENAME || 'tabela-cores-v2',
  assetTabelaEspessuraBaseName: process.env.ASSET_TABELA_ESPESSURA_BASENAME || 'tabela-espessura',
  assetTabelaProfundidadeBaseName: process.env.ASSET_TABELA_PROFUNDIDADE_BASENAME || 'tabela-profundidade-3mm',
};

if (env.maxReplyDelayMs < env.minReplyDelayMs) env.maxReplyDelayMs = env.minReplyDelayMs;
if (env.typingMaxMs < env.typingMinMs) env.typingMaxMs = env.typingMinMs;

module.exports = { env };
