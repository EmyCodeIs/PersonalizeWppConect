'use strict';

const { messages } = require('../core/messages');
const {
  sendMenu,
  buildColorTypeMenu,
  buildSolidColorMenu,
  buildMirrorColorMenu,
  buildDepthMenu,
} = require('../core/menuCatalog');
const {
  sendTabelaCores,
  sendTabelaEspessura,
  sendTabelaProfundidade,
} = require('../core/mostruario');
const { normalizeText } = require('../core/parsers');
const Store = require('../services/leadStore');

const SOLID_COLORS = [
  ['cor_preto', 'Preto'],
  ['cor_branco', 'Branco'],
  ['cor_cinza', 'Cinza'],
  ['cor_azul', 'Azul'],
  ['cor_verde', 'Verde'],
  ['cor_vermelho', 'Vermelho'],
  ['cor_amarelo', 'Amarelo'],
];

const MIRROR_COLORS = [
  ['cor_dourado', 'Dourado'],
  ['cor_prata', 'Prata'],
  ['cor_rose', 'Rosê'],
  ['cor_esp_vermelho', 'Vermelho espelhado'],
  ['cor_esp_verde', 'Verde espelhado'],
  ['cor_esp_azul', 'Azul espelhado'],
  ['cor_esp_roxo', 'Roxo espelhado'],
];

const MIRROR_NAMES = new Set(MIRROR_COLORS.map(([, label]) => normalizeText(label)));

function isBack(text) {
  const raw = normalizeText(text);
  return raw === 'voltar'
    || raw === 'cor_voltar'
    || raw === 'cor_tipo_voltar'
    || raw === 'corq_voltar';
}

function parseAcrylicType(text) {
  const raw = normalizeText(text);
  if (/acr_colorido|colorido|cores solidas|cor solida/.test(raw)) return 'Colorido';
  if (/acr_pintado|personalizado|pantone|pintado/.test(raw)) return 'Personalizado';
  return null;
}

function parseQuantity(text) {
  const raw = normalizeText(text);
  const idMatch = raw.match(/corq_([1-5])/);
  if (idMatch) return Number(idMatch[1]);
  const titleMatch = raw.match(/^([1-5])\s*cor(?:es)?\b/);
  if (titleMatch) return Number(titleMatch[1]);
  if (/^[1-5]$/.test(raw)) return Number(raw);
  return null;
}

function parseColorType(text) {
  const raw = normalizeText(text);
  if (/cor_tipo_solida|cor solida|solida/.test(raw)) return 'solida';
  if (/cor_tipo_espelhado|cor espelhada|espelhada|espelhado/.test(raw)) return 'espelhada';
  return null;
}

function parseColor(text, palette) {
  const raw = normalizeText(text);
  const colors = palette === 'espelhada' ? MIRROR_COLORS : SOLID_COLORS;

  for (const [id, label] of colors) {
    if (raw === normalizeText(id) || raw === normalizeText(label)) return label;
  }

  return null;
}

function parseDepth(text) {
  const raw = normalizeText(text);
  if (raw === 'esp3_keep' || /manter|seguir com|sem acrescimo/.test(raw)) {
    return { extra: null };
  }
  if (raw === 'esp3_add3' || /\+?\s*3mm|adicionar 3|acrescentar 3/.test(raw)) {
    return { extra: '+3mm' };
  }
  if (raw === 'esp3_add6' || /\+?\s*6mm|adicionar 6|acrescentar 6/.test(raw)) {
    return { extra: '+6mm' };
  }
  if (raw === 'esp3_add10' || /\+?\s*10mm|adicionar 10|acrescentar 10/.test(raw)) {
    return { extra: '+10mm' };
  }
  return null;
}

function listToPt(items) {
  const list = (items || []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} e ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
}

function buildBaseThickness(colors) {
  const solid = [];
  const mirror = [];

  for (const color of colors || []) {
    if (MIRROR_NAMES.has(normalizeText(color))) mirror.push(color);
    else solid.push(color);
  }

  const parts = [];
  if (solid.length) {
    parts.push(`${solid.length === 1 ? 'a cor' : 'as cores'} ${listToPt(solid)} ${solid.length === 1 ? 'possui' : 'possuem'} espessura padrão de 3mm`);
  }
  if (mirror.length) {
    parts.push(`${mirror.length === 1 ? 'a cor' : 'as cores'} ${listToPt(mirror)} ${mirror.length === 1 ? 'possui' : 'possuem'} espessura padrão de 2mm`);
  }

  const label = solid.length && mirror.length ? '3mm e 2mm' : (mirror.length ? '2mm' : '3mm');
  const message = parts.length
    ? `🔎 Observação: ${parts.join(' e ')}.`
    : '🔎 Observação: as cores escolhidas possuem espessura padrão conforme o catálogo.';

  return { label, message, solid, mirror };
}

function colorProgress(d) {
  const total = Math.max(1, Math.min(5, Number(d.corBasicaQtd || 1) || 1));
  const index = Math.max(1, Math.min(total, Number(d.corBasicaIndex || 1) || 1));
  return { total, index };
}

async function askQuantity(channel, clientId, session) {
  session.etapa = 'qtd_cores';
  Store.saveSession(session);
  await sendMenu(channel, clientId, 'quantidadeCores', { interactiveOnly: true });
}

async function askColorType(channel, clientId, session) {
  const { total, index } = colorProgress(session.dados);
  session.etapa = 'cor_tipo';
  Store.saveSession(session);
  await sendMenu(channel, clientId, buildColorTypeMenu(index, total), { interactiveOnly: true });
}

async function askSolidColor(channel, clientId, session) {
  const { total, index } = colorProgress(session.dados);
  session.etapa = 'cor_solida';
  Store.saveSession(session);
  await sendMenu(channel, clientId, buildSolidColorMenu(index, total), { interactiveOnly: true });
}

async function askMirrorColor(channel, clientId, session) {
  const { total, index } = colorProgress(session.dados);
  session.etapa = 'cor_espelhada';
  Store.saveSession(session);
  await sendMenu(channel, clientId, buildMirrorColorMenu(index, total), { interactiveOnly: true });
}

async function finishColor(channel, clientId, session, color) {
  const d = session.dados;
  const { total, index } = colorProgress(d);

  if (!Array.isArray(d.coresSelecionadas)) d.coresSelecionadas = [];
  d.coresSelecionadas.push(color);
  d.corUnica = total === 1 ? color : null;

  if (index < total) {
    d.corBasicaIndex = index + 1;
    Store.saveSession(session);
    await channel.sendText(clientId, `Cor ${index} anotada: ${color}. Agora selecione a próxima cor.`);
    await askColorType(channel, clientId, session);
    return true;
  }

  d.corBasicaIndex = total;
  const thickness = buildBaseThickness(d.coresSelecionadas);
  d.espessuraBaseLabel = thickness.label;
  d.espessuraBaseDescricao = thickness.message;
  d.espessura = thickness.label;
  d.acrescimoAcrilico = null;
  session.etapa = 'profundidade';
  Store.saveSession(session);

  const summary = total === 1
    ? `Cor anotada: ${color}.`
    : `Cores anotadas: ${d.coresSelecionadas.join(', ')}.`;

  await channel.sendText(clientId, summary);
  await channel.sendText(clientId, thickness.message);
  await sendTabelaProfundidade(channel, clientId);
  await sendMenu(channel, clientId, buildDepthMenu(thickness.label), { interactiveOnly: true });
  return true;
}

async function handleAcrylicType({ clientId, input, channel, session }) {
  const type = parseAcrylicType(input);
  if (!type) return false;

  const d = session.dados;
  d.tipoAcrilico = type;

  if (type === 'Personalizado') {
    session.etapa = 'pantone';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askPantone);
    await sendTabelaEspessura(channel, clientId);
    return true;
  }

  d.tipoCor = 'prontas';
  d.corUnica = null;
  d.coresSelecionadas = [];
  d.corBasicaQtd = null;
  d.corBasicaIndex = null;
  d.espessuraBaseLabel = null;
  d.espessuraBaseDescricao = null;
  d.acrescimoAcrilico = null;

  Store.saveSession(session);
  await sendTabelaCores(channel, clientId);
  await askQuantity(channel, clientId, session);
  return true;
}

async function handleColorSelectionMessage({ clientId, text, channel }) {
  const session = Store.getSession(clientId);
  if (!session || !channel) return false;

  const input = String(text || '').trim();
  if (!input) return false;

  const d = session.dados || (session.dados = {});

  if (session.etapa === 'tipo_acrilico') {
    return handleAcrylicType({ clientId, input, channel, session });
  }

  if (session.etapa === 'qtd_cores') {
    if (isBack(input)) {
      session.etapa = 'tipo_acrilico';
      Store.saveSession(session);
      await sendMenu(channel, clientId, 'tipoAcrilico', { interactiveOnly: true });
      return true;
    }

    const quantity = parseQuantity(input);
    if (!quantity) {
      await askQuantity(channel, clientId, session);
      return true;
    }

    d.corBasicaQtd = quantity;
    d.corBasicaIndex = 1;
    d.coresSelecionadas = [];
    d.corUnica = null;
    Store.saveSession(session);
    await askColorType(channel, clientId, session);
    return true;
  }

  if (session.etapa === 'cor_tipo') {
    if (isBack(input)) {
      await askQuantity(channel, clientId, session);
      return true;
    }

    const type = parseColorType(input);
    if (type === 'solida') {
      await askSolidColor(channel, clientId, session);
      return true;
    }
    if (type === 'espelhada') {
      await askMirrorColor(channel, clientId, session);
      return true;
    }

    await askColorType(channel, clientId, session);
    return true;
  }

  if (session.etapa === 'cor_solida') {
    if (isBack(input)) {
      await askColorType(channel, clientId, session);
      return true;
    }

    const color = parseColor(input, 'solida');
    if (!color) {
      await askSolidColor(channel, clientId, session);
      return true;
    }

    return finishColor(channel, clientId, session, color);
  }

  if (session.etapa === 'cor_espelhada') {
    if (isBack(input)) {
      await askColorType(channel, clientId, session);
      return true;
    }

    const color = parseColor(input, 'espelhada');
    if (!color) {
      await askMirrorColor(channel, clientId, session);
      return true;
    }

    return finishColor(channel, clientId, session, color);
  }

  if (session.etapa === 'profundidade' && d.tipoAcrilico === 'Colorido') {
    const depth = parseDepth(input);
    if (!depth) return false;

    const base = d.espessuraBaseLabel || '3mm';
    d.acrescimoAcrilico = depth.extra;
    d.espessura = depth.extra ? `${base} ${depth.extra}` : base;
    session.etapa = 'arte';
    Store.saveSession(session);
    await sendMenu(channel, clientId, 'arte');
    return true;
  }

  return false;
}

module.exports = {
  handleColorSelectionMessage,
  parseQuantity,
  parseColorType,
  parseColor,
  buildBaseThickness,
};
