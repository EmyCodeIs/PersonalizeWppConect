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
  let text = args.text;
  const session = Store.getSession(clientId);

  if (!session) return originalProcessCustomerMessage(args);
  const data = session.dados || (session.dados = {});

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
  deliveryOf,
  isGrandeBH,
};
