'use strict';

const { messages } = require('../core/messages');
const { detectInitialContext } = require('../core/intent');
const { parseMeasure, splitColors, normalizeText, extractName, extractPhone } = require('../core/parsers');
const Store = require('../services/leadStore');
const { env } = require('../config/env');

function optionNumber(text) {
  const raw = normalizeText(text);
  const m = raw.match(/\b([1-5])\b/);
  if (m) return Number(m[1]);
  if (/sim|letreiro|acrilico|acrílico/.test(raw)) return 1;
  if (/nao|não|outro/.test(raw)) return 2;
  return null;
}

function deliveryFromText(text) {
  const n = optionNumber(text);
  const raw = normalizeText(text);
  if (n === 1 || /correio|transport/.test(raw)) return 'Correios';
  if (n === 2 || /instala/.test(raw)) return 'Instalação';
  if (n === 3 || /retir/.test(raw)) return 'Retirada';
  return null;
}

function acrylicTypeFromText(text) {
  const n = optionNumber(text);
  const raw = normalizeText(text);
  if (n === 1 || /color|solida|sólida/.test(raw)) return 'Colorido';
  if (n === 2 || /pantone|personal/.test(raw)) return 'Personalizado';
  return null;
}

function depthFromText(text) {
  const n = optionNumber(text);
  const raw = normalizeText(text);
  if (n === 1) return '3mm';
  if (n === 2) return '+3mm';
  if (n === 3) return '+6mm';
  if (n === 4) return '+10mm';
  if (/seguir|sem acrescimo|sem acréscimo|3mm/.test(raw)) return '3mm';
  if (/\+\s*3/.test(raw)) return '+3mm';
  if (/\+\s*6/.test(raw)) return '+6mm';
  if (/\+\s*10/.test(raw)) return '+10mm';
  return null;
}

function personalizedThicknessFromText(text) {
  const n = optionNumber(text);
  const raw = normalizeText(text);
  if (n === 1 || /4/.test(raw)) return '4mm';
  if (n === 2 || /6/.test(raw)) return '6mm';
  if (n === 3 || /10/.test(raw)) return '10mm';
  return null;
}

function artFromText(text) {
  const n = optionNumber(text);
  const raw = normalizeText(text);
  if (n === 1 || /pdf|ai|eps|svg|arquivo/.test(raw)) return 'Tenho arquivo';
  if (n === 2 || /imagem|referencia|referência|print/.test(raw)) return 'Imagem de referência';
  if (n === 3 || /ideia|descrever|descrev/.test(raw)) return 'Descrever ideia';
  if (String(text || '').trim().length > 2) return String(text).trim();
  return null;
}

function buildLead(session, reason) {
  return {
    clientId: session.id,
    reason,
    etapa: session.etapa,
    dados: session.dados,
  };
}

function buildBusinessNote(session, reason = 'lead') {
  const d = session.dados || {};
  return [
    reason === 'letreiro_aguardando_orcamento'
      ? '🟢 Aguardando orçamento - Bot WPPConnect'
      : 'Cliente veio pelo bot WPPConnect',
    `Motivo: ${reason}`,
    d.origem ? `Origem: ${d.origem}` : null,
    d.nome ? `Nome: ${d.nome}` : null,
    d.telefone ? `Telefone: ${d.telefone}` : null,
    d.flow ? `Fluxo: ${d.flow}` : null,
    d.tipoAcrilico ? `Tipo: ${d.tipoAcrilico}` : null,
    d.pantoneDescricao ? `Pantone/cor personalizada: ${d.pantoneDescricao}` : null,
    d.coresSelecionadas?.length ? `Cores: ${d.coresSelecionadas.join(', ')}` : null,
    d.corBasicaQtd ? `Qtd. cores: ${d.corBasicaQtd}` : null,
    d.espessura ? `Espessura/acréscimo: ${d.espessura}` : null,
    d.arte ? `Arte: ${d.arte}` : null,
    d.medida?.descricao ? `Medida: ${d.medida.descricao}` : null,
    d.cidade ? `Cidade: ${d.cidade}` : null,
    d.envio ? `Envio: ${d.envio}` : null,
    d.endereco ? `Endereço: ${d.endereco}` : null,
  ].filter(Boolean).join('\n');
}

async function maybeSetBusinessNote(channel, clientId, session, reason = 'lead') {
  if (!env.enableContactNotes || !channel?.setContactNote) return;
  await channel.setContactNote(clientId, buildBusinessNote(session, reason)).catch(() => null);
}

async function markAwaitingQuote(channel, clientId, session) {
  await maybeSetBusinessNote(channel, clientId, session, 'letreiro_aguardando_orcamento');
  if (env.enableContactLabels && channel?.applyContactLabel) {
    await channel.applyContactLabel(clientId, {
      name: env.awaitingQuoteLabelName,
      color: env.awaitingQuoteLabelColor,
    }).catch(() => null);
  }
}

async function processCustomerMessage({ clientId, text, channel }) {
  const session = Store.getSession(clientId);
  const input = String(text || '').trim();
  if (!session || !input) return session;

  const d = session.dados;
  const foundName = extractName(input);
  const foundPhone = extractPhone(input);
  if (foundName && !d.nome) d.nome = foundName;
  if (foundPhone && !d.telefone) d.telefone = foundPhone;

  if (/^\/(reset|reiniciar)$/i.test(input)) {
    const fresh = Store.resetSession(clientId);
    await channel.sendText(clientId, 'Atendimento reiniciado para teste. Envie uma nova mensagem para começar.');
    return fresh;
  }

  if (session.etapa === 'inicio') {
    const initial = detectInitialContext(input);
    d.initial = initial;
    d.origem = initial.isLanding ? 'landing/site' : 'whatsapp';
    if (initial.name && !d.nome) d.nome = initial.name;
    if (initial.phone && !d.telefone) d.telefone = initial.phone;

    await channel.sendText(clientId, messages.welcome(d.nome));

    if (initial.flow === 'outro_servico') {
      d.flow = 'outro_servico';
      session.etapa = 'aguardando_vendedor_outro_servico';
      Store.saveSession(session);
      const lead = Store.appendLead(buildLead(session, 'outro_servico_primeira_mensagem'));
      await maybeSetBusinessNote(channel, clientId, session, 'outro_servico');
      await channel.sendText(clientId, messages.nonLettering);
      return { ...session, lead };
    }

    if (initial.flow === 'letreiro') {
      d.flow = 'letreiro';
      session.etapa = 'tipo_acrilico';
      Store.saveSession(session);
      await channel.sendText(clientId, messages.mostruario);
      await channel.sendText(clientId, messages.askAcrylicType);
      return session;
    }

    session.etapa = 'confirmar_fluxo';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askFlow);
    return session;
  }

  if (session.etapa === 'confirmar_fluxo') {
    const opt = optionNumber(input);
    if (opt === 1) {
      d.flow = 'letreiro';
      session.etapa = 'tipo_acrilico';
      Store.saveSession(session);
      await channel.sendText(clientId, messages.mostruario);
      await channel.sendText(clientId, messages.askAcrylicType);
      return session;
    }
    if (opt === 2) {
      d.flow = 'outro_servico';
      session.etapa = 'aguardando_vendedor_outro_servico';
      Store.saveSession(session);
      const lead = Store.appendLead(buildLead(session, 'outro_servico_confirmado'));
      await maybeSetBusinessNote(channel, clientId, session, 'outro_servico');
      await channel.sendText(clientId, messages.nonLettering);
      return { ...session, lead };
    }
    await channel.sendText(clientId, messages.askFlow);
    return session;
  }

  if (session.etapa === 'tipo_acrilico') {
    const tipo = acrylicTypeFromText(input);
    if (!tipo) {
      await channel.sendText(clientId, messages.askAcrylicType);
      return session;
    }
    d.tipoAcrilico = tipo;
    if (tipo === 'Personalizado') {
      session.etapa = 'pantone';
      Store.saveSession(session);
      await channel.sendText(clientId, messages.askPantone);
      return session;
    }
    session.etapa = 'qtd_cores';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askColorCount);
    return session;
  }

  if (session.etapa === 'pantone') {
    d.pantoneDescricao = input;
    session.etapa = 'espessura_personalizada';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askPersonalizedThickness);
    return session;
  }

  if (session.etapa === 'qtd_cores') {
    const n = optionNumber(input);
    if (!n || n < 1 || n > 5) {
      await channel.sendText(clientId, messages.askColorCount);
      return session;
    }
    d.corBasicaQtd = n;
    session.etapa = 'cores';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askSolidColors);
    return session;
  }

  if (session.etapa === 'cores') {
    const colors = splitColors(input);
    if (!colors.length) {
      await channel.sendText(clientId, messages.askSolidColors);
      return session;
    }
    d.coresSelecionadas = colors;
    session.etapa = 'profundidade';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.fixed3mm);
    await channel.sendText(clientId, messages.askDepth);
    return session;
  }

  if (session.etapa === 'profundidade') {
    const depth = depthFromText(input);
    if (!depth) {
      await channel.sendText(clientId, messages.askDepth);
      return session;
    }
    d.espessura = depth;
    session.etapa = 'arte';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askArt);
    return session;
  }

  if (session.etapa === 'espessura_personalizada') {
    const thickness = personalizedThicknessFromText(input);
    if (!thickness) {
      await channel.sendText(clientId, messages.askPersonalizedThickness);
      return session;
    }
    d.espessura = thickness;
    session.etapa = 'arte';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askArt);
    return session;
  }

  if (session.etapa === 'arte') {
    const art = artFromText(input);
    if (!art) {
      await channel.sendText(clientId, messages.askArt);
      return session;
    }
    d.arte = art;
    session.etapa = 'medida';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askArtFree);
    await channel.sendText(clientId, messages.askMeasure);
    return session;
  }

  if (session.etapa === 'medida') {
    const measure = parseMeasure(input);
    if (!measure) {
      await channel.sendText(clientId, messages.invalidMeasure);
      return session;
    }
    d.medida = measure;
    session.etapa = 'cidade';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askCity);
    return session;
  }

  if (session.etapa === 'cidade') {
    d.cidade = input;
    session.etapa = 'envio';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askDelivery);
    return session;
  }

  if (session.etapa === 'envio') {
    const delivery = deliveryFromText(input);
    if (!delivery) {
      await channel.sendText(clientId, messages.askDelivery);
      return session;
    }
    d.envio = delivery;
    if (delivery === 'Retirada') {
      session.etapa = 'lead_completo';
      session.completed = true;
      Store.saveSession(session);
      const lead = Store.appendLead(buildLead(session, 'letreiro_pre_atendimento_completo'));
      await markAwaitingQuote(channel, clientId, session);
      await channel.sendText(clientId, messages.pickupAddress);
      await channel.sendText(clientId, messages.forwardQuote);
      return { ...session, lead };
    }
    if (delivery === 'Instalação') {
      await channel.sendText(clientId, messages.installationNote);
    }
    session.etapa = 'endereco';
    Store.saveSession(session);
    await channel.sendText(clientId, messages.askAddress);
    return session;
  }

  if (session.etapa === 'endereco') {
    d.endereco = input;
    session.etapa = 'lead_completo';
    session.completed = true;
    Store.saveSession(session);
    const lead = Store.appendLead(buildLead(session, 'letreiro_pre_atendimento_completo'));
    await markAwaitingQuote(channel, clientId, session);
    await channel.sendText(clientId, messages.forwardQuote);
    return { ...session, lead };
  }

  await channel.sendText(clientId, 'Seu atendimento já foi registrado. Um vendedor poderá continuar por aqui.');
  return session;
}

module.exports = { processCustomerMessage, buildBusinessNote };
