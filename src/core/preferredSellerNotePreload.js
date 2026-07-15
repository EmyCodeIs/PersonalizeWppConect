'use strict';

const Store = require('../services/leadStore');
const { env } = require('../config/env');
const { normalizeText } = require('./parsers');

function clean(value) {
  return String(value || '').trim();
}

function looksLikeEncodedMedia(value = '') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length < 256) return false;
  if (/^data:[^;]+;base64,/i.test(compact)) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function safeText(value, maxLength = 700) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !looksLikeEncodedMedia(line))
    .filter((line) => !/^\[(imagem|arquivo|documento|video|vídeo|audio|áudio) enviad[oa]/i.test(line));

  const text = lines.join(' | ').replace(/\s{2,}/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

function serviceTitle(flow) {
  if (flow === 'letreiro') return 'LETREIRO';
  if (flow === 'plotagem') return 'PLOTAGEM';
  return 'OUTROS';
}

function serviceName(flow) {
  if (flow === 'letreiro') return 'Letreiro de acrílico';
  if (flow === 'plotagem') return 'Plotagem';
  return 'Outro serviço/produto';
}

function serviceLabelColor(flow) {
  if (flow === 'letreiro') return env.serviceLabelLetreiroColor;
  if (flow === 'plotagem') return env.serviceLabelPlotagemColor;
  return env.serviceLabelOutrosColor;
}

function colorCircle(value) {
  const color = normalizeText(value);
  const circles = {
    purple: '🟣',
    roxo: '🟣',
    green: '🟢',
    verde: '🟢',
    red: '🔴',
    vermelho: '🔴',
    blue: '🔵',
    azul: '🔵',
    yellow: '🟡',
    amarelo: '🟡',
    orange: '🟠',
    laranja: '🟠',
    black: '⚫',
    preto: '⚫',
    gray: '⚪',
    grey: '⚪',
    cinza: '⚪',
    white: '⚪',
    branco: '⚪',
    pink: '🩷',
    rosa: '🩷',
  };
  return circles[color] || '⚪';
}

function serviceHeader(flow) {
  return `${colorCircle(serviceLabelColor(flow))} PRÉ ATENDIDO ${serviceTitle(flow)}`;
}

function supportHeader() {
  return `${colorCircle(env.supportLabelColor)} SUPORTE SOLICITADO`;
}

function formatCity(value) {
  const city = clean(value).replace(/\s*\/\s*/g, '/');
  if (/^bh$/i.test(city)) return 'Belo Horizonte/MG';
  return city || 'Não informada';
}

function originLine(value) {
  const origin = normalizeText(value);
  if (origin.includes('landing') || origin.includes('site')) return '🌐 Veio da Landing Page';
  return '💬 Veio pelo WhatsApp';
}

function formatMeasure(data = {}) {
  const measure = data.medida || {};
  if (data.tamanhoModo === 'completo') return `${measure.largura} x ${measure.altura} cm`;
  if (data.tamanhoModo === 'largura') return `${measure.largura} cm de largura; altura proporcional à arte`;
  if (data.tamanhoModo === 'altura') return `${measure.altura} cm de altura; largura proporcional à arte`;
  return safeText(data.tamanhoDescricao, 250) || 'Não informada';
}

function formatThickness(data = {}) {
  if (data.espessuraAAlinhar) return 'A definir com o vendedor';

  const source = [
    data.espessuraBaseLabel,
    data.espessuraBaseDescricao,
    data.espessura,
  ].map(clean).filter(Boolean).join(' ');

  const matches = source.match(/\b\d+mm\b/gi) || [];
  const unique = [...new Set(matches.map((item) => item.toLowerCase()))];
  if (unique.length) return unique.join(' e ');

  const direct = safeText(data.espessura, 80);
  return direct || 'Não informada';
}

function formatMediaCount(items = []) {
  const counts = { image: 0, document: 0, video: 0, audio: 0 };

  for (const item of items || []) {
    const type = String(item?.type || '').toLowerCase();
    if (type === 'image') counts.image += 1;
    else if (type === 'document') counts.document += 1;
    else if (type === 'video') counts.video += 1;
    else if (type === 'audio') counts.audio += 1;
  }

  const parts = [];
  if (counts.image) parts.push(`${counts.image} ${counts.image === 1 ? 'imagem recebida' : 'imagens recebidas'}`);
  if (counts.document) parts.push(`${counts.document} ${counts.document === 1 ? 'arquivo recebido' : 'arquivos recebidos'}`);
  if (counts.video) parts.push(`${counts.video} ${counts.video === 1 ? 'vídeo recebido' : 'vídeos recebidos'}`);
  if (counts.audio) parts.push(`${counts.audio} ${counts.audio === 1 ? 'áudio recebido' : 'áudios recebidos'}`);
  return parts.join(', ');
}

function formatReceivedMedia(data = {}) {
  const allItems = [
    ...(Array.isArray(data.arteMedias) ? data.arteMedias : []),
    ...(Array.isArray(data.pantoneMedias) ? data.pantoneMedias : []),
  ];
  return formatMediaCount(allItems) || 'Não recebeu arquivo';
}

function formatAttendedAt(value) {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return safeDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function buildLetreiroLines(data = {}) {
  const lines = [
    `Serviço: ${serviceName(data.flow)}`,
    `Acrílico: ${data.tipoAcrilico === 'pintado' ? 'Personalizado/Pantone' : 'Colorido'}`,
  ];

  const pantone = safeText(data.pantoneDescricao, 250);
  if (pantone) lines.push(`Cor personalizada: ${pantone}`);

  if (Array.isArray(data.coresSelecionadas) && data.coresSelecionadas.length) {
    lines.push(`${data.coresSelecionadas.length === 1 ? 'Cor' : 'Cores'}: ${data.coresSelecionadas.join(', ')}`);
  }

  lines.push(`Espessura: ${formatThickness(data)}`);

  if (data.acrescimoAcrilico && data.acrescimoAcrilico !== '0mm') {
    lines.push(`Acréscimo: +${data.acrescimoAcrilico} em acrílico cristal`);
  } else if (data.acrescimoAcrilicoAAlinhar) {
    lines.push('Acréscimo: A definir com o vendedor');
  }

  lines.push(`Medida: ${formatMeasure(data)}`);
  lines.push(`Arte/referências: ${formatReceivedMedia(data)}`);

  const artText = safeText(data.arteTexto, 450);
  if (artText) lines.push(`Detalhes da arte: ${artText}`);

  if (data.envio) {
    lines.push(`Recebimento: ${data.envio === 'Retirada' ? 'Retirada na empresa' : data.envio}`);
  }
  if (data.endereco) lines.push(`Endereço: ${safeText(data.endereco, 300)}`);

  return lines;
}

function buildOtherServiceLines(data = {}) {
  const demand = data.demanda || {};
  const lines = [`Serviço: ${serviceName(data.flow)}`];

  if (demand.descricao) lines.push(`Solicitação: ${safeText(demand.descricao, 500)}`);
  if (demand.medida) lines.push(`Medida: ${safeText(demand.medida, 250)}`);
  if (demand.local) lines.push(`Local de aplicação: ${safeText(demand.local, 300)}`);
  if (demand.referencia) lines.push(`Referências/detalhes: ${safeText(demand.referencia, 500)}`);

  const media = formatMediaCount(demand.medias);
  if (media) lines.push(`Referências/arquivos: ${media}`);

  if (demand.prazo) lines.push(`Prazo: ${safeText(demand.prazo, 250)}`);
  return lines;
}

function buildSupportNote(session = {}) {
  const data = session.dados || {};
  const support = data.support || {};
  const contextLines = data.flow === 'letreiro'
    ? buildLetreiroLines(data)
    : (data.flow ? buildOtherServiceLines(data) : []);
  const supportText = safeText(support.text, 1200) || 'Cliente enviou somente anexo(s).';
  const media = formatMediaCount(support.medias) || 'Não recebeu arquivo';

  return [
    supportHeader(),
    '',
    '👤',
    'CLIENTE',
    `Nome: ${safeText(data.nome, 100) || 'Não informado'}`,
    `Cidade: ${formatCity(data.cidade)}`,
    originLine(data.origem),
    ...(contextLines.length ? ['', '📋', 'CONTEXTO DO PEDIDO', ...contextLines] : []),
    '',
    '🛟',
    'SUPORTE',
    `Motivo: ${supportText}`,
    `Arquivos: ${media}`,
    'Status: Aguardando atendimento da equipe',
    '',
    `Solicitado em: ${formatAttendedAt(support.forwardedAt || support.requestedAt)}`,
  ].join('\n');
}

function buildPreferredSellerNote(session = {}) {
  const data = session.dados || {};
  if (data.support?.status === 'forwarded' || data.support?.forwardedAt) {
    return buildSupportNote(session);
  }

  const requestLines = data.flow === 'letreiro'
    ? buildLetreiroLines(data)
    : buildOtherServiceLines(data);
  const observation = safeText(data.observacaoPedido, 700) || 'Não teve';

  return [
    serviceHeader(data.flow),
    '',
    '👤',
    'CLIENTE',
    `Nome: ${safeText(data.nome, 100) || 'Não informado'}`,
    `Cidade: ${formatCity(data.cidade)}`,
    originLine(data.origem),
    '',
    '📋',
    'PEDIDO',
    ...requestLines,
    `Observação: ${observation}`,
    '',
    `Atendido em: ${formatAttendedAt(data.completedAt)}`,
  ].join('\n');
}

function installPreferredSellerNoteFormatter(channel) {
  if (!channel || channel.__preferredSellerNoteFormatterInstalled || typeof channel.setContactNote !== 'function') return;

  const originalSetContactNote = channel.setContactNote.bind(channel);
  channel.setContactNote = async (clientId, originalNote) => {
    const session = Store.getSession(clientId);
    const note = session ? buildPreferredSellerNote(session) : originalNote;
    return originalSetContactNote(clientId, note || originalNote);
  };
  channel.__preferredSellerNoteFormatterInstalled = true;
}

const CustomerFlow = require('../flow/customerFlow');
const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;

CustomerFlow.processCustomerMessage = async function processCustomerMessageWithPreferredNote(args = {}) {
  installPreferredSellerNoteFormatter(args.channel);
  return originalProcessCustomerMessage(args);
};

module.exports = {
  buildPreferredSellerNote,
  buildSupportNote,
  installPreferredSellerNoteFormatter,
  _test: {
    colorCircle,
    formatAttendedAt,
    formatCity,
    formatMediaCount,
    formatMeasure,
    formatThickness,
    originLine,
    safeText,
    serviceHeader,
    serviceLabelColor,
    supportHeader,
  },
};
