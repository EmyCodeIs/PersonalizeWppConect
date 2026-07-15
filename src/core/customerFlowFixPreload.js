'use strict';

const MenuCatalog = require('./menuCatalog');
const { messages } = require('./messages');
const Store = require('../services/leadStore');
const { normalizeText } = require('./parsers');

function clean(value) {
  return String(value || '').trim();
}

function firstLine(value) {
  return clean(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function normalized(value) {
  return normalizeText(firstLine(value));
}

function deliveryOf(value) {
  const text = normalized(value);
  if (text === 'envio_correios' || /correio|transportadora/.test(text)) return 'Correios';
  if (text === 'envio_instalacao' || /instala/.test(text)) return 'Instalação';
  if (text === 'envio_retirada_cliente' || /retir/.test(text)) return 'Retirada';
  return null;
}

function isGrandeBH(city) {
  const text = normalizeText(city);
  if (!text) return false;
  if (/\bbh\b/.test(text) || text.includes('belo horizonte')) return true;
  return [
    'contagem', 'betim', 'nova lima', 'ribeirao das neves', 'santa luzia',
    'vespasiano', 'ibirite', 'sabara', 'lagoa santa', 'raposos', 'brumadinho',
    'sarzedo', 'mateus leme', 'pedro leopoldo', 'confins', 'sao jose da lapa',
  ].some((name) => text.includes(name));
}

function looksLikeEncodedMedia(value = '') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (compact.length < 256) return false;
  if (/^data:[^;]+;base64,/i.test(compact)) return true;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function safeCustomerText(value, maxLength = 1000) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !looksLikeEncodedMedia(line))
    .filter((line) => !/^\[(imagem|arquivo|documento|video|vídeo) enviado/i.test(line));

  const text = lines.join(' | ').replace(/\s{2,}/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

function inboundMediaType(messagesList = []) {
  const types = [];
  for (const item of messagesList || []) {
    const raw = item?.raw || item || {};
    const type = String(raw?.type || raw?.mimetype || raw?.mediaType || '').toLowerCase();
    const filename = raw?.filename || raw?.fileName || raw?.document?.filename || '';
    if (/image/.test(type)) types.push('imagem');
    else if (/document|pdf|application/.test(type) || filename) types.push('arquivo');
    else if (/video/.test(type)) types.push('vídeo');
  }
  return types[0] || '';
}

function sanitizeMediaCollectionInput(value, messagesList = []) {
  const safeText = safeCustomerText(value, 1200);
  if (safeText) return safeText;

  const mediaType = inboundMediaType(messagesList);
  return mediaType ? `[${mediaType} enviada]` : value;
}

function formatService(flow) {
  if (flow === 'letreiro') return 'Letreiro de acrílico';
  if (flow === 'plotagem') return 'Plotagem';
  if (flow === 'outros') return 'Outro serviço/produto';
  return clean(flow) || 'Não informado';
}

function formatCity(value) {
  const city = clean(value).replace(/\s*\/\s*/g, '/');
  if (/^bh$/i.test(city)) return 'Belo Horizonte/MG';
  return city;
}

function formatMeasure(data = {}) {
  const measure = data.medida || {};
  if (data.tamanhoModo === 'completo') return `${measure.largura} x ${measure.altura} cm`;
  if (data.tamanhoModo === 'largura') return `${measure.largura} cm de largura; altura proporcional à arte`;
  if (data.tamanhoModo === 'altura') return `${measure.altura} cm de altura; largura proporcional à arte`;
  return clean(data.tamanhoDescricao) || '';
}

function formatMediaCount(items = []) {
  const counts = { image: 0, document: 0, video: 0 };
  for (const item of items || []) {
    const type = String(item?.type || '').toLowerCase();
    if (type === 'image') counts.image += 1;
    else if (type === 'document') counts.document += 1;
    else if (type === 'video') counts.video += 1;
  }

  const parts = [];
  if (counts.image) parts.push(`${counts.image} ${counts.image === 1 ? 'imagem recebida' : 'imagens recebidas'}`);
  if (counts.document) parts.push(`${counts.document} ${counts.document === 1 ? 'arquivo recebido' : 'arquivos recebidos'}`);
  if (counts.video) parts.push(`${counts.video} ${counts.video === 1 ? 'vídeo recebido' : 'vídeos recebidos'}`);
  return parts.join(', ');
}

function formatBaseThickness(data = {}) {
  const direct = clean(data.espessuraBaseLabel || data.espessura);
  if (direct && direct !== 'a definir') return direct;

  const matches = clean(data.espessuraBaseDescricao).match(/\b\d+mm\b/gi) || [];
  return [...new Set(matches.map((item) => item.toLowerCase()))].join(' e ');
}

function buildSellerNote(session = {}) {
  const data = session.dados || {};
  const demand = data.demanda || {};
  const customerLines = [
    data.nome && `Nome: ${safeCustomerText(data.nome, 80)}`,
    data.telefone && `Telefone: ${safeCustomerText(data.telefone, 40)}`,
    data.cidade && `Cidade: ${formatCity(data.cidade)}`,
  ].filter(Boolean);

  const detailLines = [`Serviço: ${formatService(data.flow)}`];

  if (data.flow === 'letreiro') {
    if (data.tipoAcrilico) {
      detailLines.push(`Acrílico: ${data.tipoAcrilico === 'pintado' ? 'Personalizado/Pantone' : 'Colorido'}`);
    }

    const pantone = safeCustomerText(data.pantoneDescricao, 300);
    if (pantone && !/^\[(imagem|arquivo|vídeo) enviada\]$/i.test(pantone)) {
      detailLines.push(`Cor personalizada: ${pantone}`);
    }

    if (Array.isArray(data.coresSelecionadas) && data.coresSelecionadas.length) {
      const label = data.coresSelecionadas.length === 1 ? 'Cor' : 'Cores';
      detailLines.push(`${label}: ${data.coresSelecionadas.join(', ')}`);
    }

    const baseThickness = formatBaseThickness(data);
    if (baseThickness) detailLines.push(`Espessura: ${baseThickness}`);
    if (data.acrescimoAcrilico && data.acrescimoAcrilico !== '0mm') {
      detailLines.push(`Acrílico cristal adicional: +${data.acrescimoAcrilico}`);
    }
    if (data.acrescimoAcrilicoAAlinhar || data.espessuraAAlinhar) {
      detailLines.push('Espessura adicional: a definir com o vendedor');
    }

    const measure = formatMeasure(data);
    if (measure) detailLines.push(`Medida: ${measure}`);

    const artText = safeCustomerText(data.arteTexto, 500);
    const artMedia = formatMediaCount(data.arteMedias);
    const pantoneMedia = formatMediaCount(data.pantoneMedias);
    const allMedia = [artMedia, pantoneMedia].filter(Boolean).join(', ');
    if (allMedia) detailLines.push(`Arte/referências: ${allMedia}`);
    if (artText && !/^\[(imagem|arquivo|vídeo) enviada\]$/i.test(artText)) {
      detailLines.push(`Descrição da arte: ${artText}`);
    }

    if (data.envio) {
      detailLines.push(`Recebimento: ${data.envio === 'Retirada' ? 'Retirada na empresa' : data.envio}`);
    }
    if (data.endereco) detailLines.push(`Endereço: ${safeCustomerText(data.endereco, 300)}`);
  } else if (data.flow === 'plotagem') {
    if (demand.descricao) detailLines.push(`Solicitação: ${safeCustomerText(demand.descricao, 500)}`);
    if (demand.medida) detailLines.push(`Medida: ${safeCustomerText(demand.medida, 200)}`);
    if (demand.local) detailLines.push(`Local de aplicação: ${safeCustomerText(demand.local, 300)}`);
    if (demand.prazo) detailLines.push(`Prazo: ${safeCustomerText(demand.prazo, 200)}`);
  } else {
    if (demand.descricao) detailLines.push(`Solicitação: ${safeCustomerText(demand.descricao, 500)}`);
    if (demand.referencia) detailLines.push(`Referências/detalhes: ${safeCustomerText(demand.referencia, 500)}`);
    if (demand.prazo) detailLines.push(`Prazo: ${safeCustomerText(demand.prazo, 200)}`);
  }

  const observation = safeCustomerText(data.observacaoPedido, 700);
  const updatedAt = new Date().toLocaleString('pt-BR');

  return [
    '🟢 PEDIDO COLETADO PELO BOT',
    'Status: Aguardando atendimento do vendedor',
    '',
    '👤 CLIENTE',
    ...(customerLines.length ? customerLines : ['Nome: Não informado']),
    '',
    '📋 PEDIDO',
    ...detailLines,
    observation && '',
    observation && '📝 OBSERVAÇÕES DO CLIENTE',
    observation && observation,
    '',
    `Atualizado em: ${updatedAt}`,
  ].filter((line) => line !== false && line !== null && line !== undefined).join('\n');
}

function installSellerNoteFormatter(channel) {
  if (!channel || channel.__sellerNoteFormatterInstalled || typeof channel.setContactNote !== 'function') return;

  const originalSetContactNote = channel.setContactNote.bind(channel);
  channel.setContactNote = async (clientId, originalNote) => {
    const session = Store.getSession(clientId);
    const note = session ? buildSellerNote(session) : safeCustomerText(originalNote, 3000);
    return originalSetContactNote(clientId, note || originalNote);
  };
  channel.__sellerNoteFormatterInstalled = true;
}

async function enterObservation(channel, clientId, session) {
  session.etapa = 'observacao_pedido_menu';
  Store.saveSession(session);
  await channel.sendText(clientId, messages.askObservation);
  await MenuCatalog.sendMenu(channel, clientId, 'observacao');
}

// A arte não usa mais lista. Mantemos o nome do menu apenas como compatibilidade
// com o fluxo antigo, mas transformamos a chamada em coleta livre por texto/mídia.
const originalSendMenu = MenuCatalog.sendMenu.bind(MenuCatalog);
MenuCatalog.sendMenu = async function sendMenuWithoutArtList(channel, clientId, menuOrName) {
  if (menuOrName === 'arte') {
    await channel.sendText(clientId, messages.askArtQuestion);
    await channel.sendText(clientId, messages.askArtExplanation);
    await channel.sendText(clientId, messages.askArtFree);
    return true;
  }
  return originalSendMenu(channel, clientId, menuOrName);
};

// Carrega o fluxo somente depois de substituir sendMenu, para que a referência
// desestruturada dentro de customerFlow já seja a versão corrigida.
const CustomerFlow = require('../flow/customerFlow');
const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;

CustomerFlow.processCustomerMessage = async function processCustomerMessageFixed(args = {}) {
  const { clientId, channel } = args;
  installSellerNoteFormatter(channel);

  let text = args.text;
  const session = Store.getSession(clientId);

  if (!session) return originalProcessCustomerMessage(args);
  const data = session.dados || (session.dados = {});

  // Impede que o corpo base64 de imagens/arquivos seja salvo como descrição.
  if (session.etapa === 'arte_coleta' || session.etapa === 'pantone') {
    text = sanitizeMediaCollectionInput(text, args.messages);
  }

  // Sessões novas e antigas entram diretamente na coleta livre da arte.
  if (session.etapa === 'arte_menu') {
    session.etapa = 'arte_coleta';
    data.arteModo = 'livre';
    data.arteTexto = null;
    data.arteMedias = [];
    data.arte = null;
    Store.saveSession(session);
  }

  if (session.etapa === 'envio') {
    const input = normalized(text);
    if (input === 'envio_voltar' || input === 'voltar') {
      data.cidade = null;
      data.envio = null;
      data.endereco = null;
      session.etapa = 'cidade';
      Store.saveSession(session);
      await channel.sendText(clientId, messages.askCity);
      return session;
    }

    const delivery = deliveryOf(text);
    if (!delivery || (delivery === 'Instalação' && !isGrandeBH(data.cidade))) {
      await MenuCatalog.sendMenu(channel, clientId, MenuCatalog.buildDeliveryMenu(isGrandeBH(data.cidade)));
      return session;
    }

    data.envio = delivery;
    if (delivery === 'Retirada') {
      data.endereco = null;
      Store.saveSession(session);
      await channel.sendText(clientId, messages.pickupAddress);
      await enterObservation(channel, clientId, session);
      return session;
    }

    session.etapa = 'endereco';
    Store.saveSession(session);
    if (delivery === 'Instalação') await channel.sendText(clientId, messages.installationNote);
    await channel.sendText(clientId, messages.askAddress);
    return session;
  }

  if (session.etapa === 'endereco') {
    const address = clean(text).replace(/\s{2,}/g, ' ');
    if (!address) {
      await channel.sendText(clientId, messages.askAddress);
      return session;
    }
    data.endereco = address;
    Store.saveSession(session);
    await channel.sendText(clientId, 'Endereço anotado!');
    await enterObservation(channel, clientId, session);
    return session;
  }

  // Compatibilidade entre os IDs reais da lista e os nomes antigos do fluxo.
  if (session.etapa === 'observacao_pedido_menu') {
    const input = normalized(text);
    if (input === normalizeText('OBS_PEDIDO|ADD') || /fazer observacao/.test(input)) {
      text = 'obs_sim';
    } else if (input === normalizeText('OBS_PEDIDO|SKIP') || /nao preciso/.test(input)) {
      text = 'obs_nao';
    }
  }

  return originalProcessCustomerMessage({ ...args, text });
};

module.exports = {
  buildSellerNote,
  deliveryOf,
  isGrandeBH,
  looksLikeEncodedMedia,
  safeCustomerText,
};
