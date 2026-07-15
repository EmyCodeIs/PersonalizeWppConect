'use strict';

const { messages } = require('./messages');
const {
  buildKeepBaseTitle,
  buildKeepBaseDescription,
} = require('../domain/acrilicoThickness');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

const menus = {
  servicos: {
    title: 'Serviços',
    description: '🔸\nQual dos nossos serviços deseja?',
    buttonText: 'Selecionar serviço',
    fallbackText: messages.askService,
    interactiveOnly: true,
    rows: [
      { id: 'serv_letreiro', title: 'Letreiro de acrílico', description: 'Solicitar orçamento do meu letreiro' },
      { id: 'serv_plotagem', title: 'Plotagem', description: 'Vitrines, paredes, veículos e adesivos' },
      { id: 'serv_outros', title: 'Outros', description: 'Placas, fachadas e outros serviços' },
      { id: 'serv_suporte', title: 'Suporte', description: 'Dúvidas ou atendimento com nossa equipe' },
    ],
  },
  tipoAcrilico: {
    title: 'Tipo de acrílico',
    description: '🔶\nSelecione o tipo de acrílico do seu letreiro:',
    buttonText: 'Selecionar Acrílico',
    fallbackText: messages.askAcrylicType,
    interactiveOnly: true,
    rows: [
      { id: 'acr_colorido', title: 'Colorido (cores sólidas)', description: 'Preto, branco, dourado, prata...' },
      { id: 'acr_pintado', title: 'Personalizado', description: 'Enviar minha cor' },
    ],
  },
  quantidadeCores: {
    title: 'Quantidade de cores',
    description: 'Quantas cores você quer no seu *letreiro?*',
    buttonText: 'Quantidade',
    fallbackText: messages.askColorCount,
    interactiveOnly: true,
    rows: [
      { id: 'corq_1', title: '1 cor', description: 'Uma cor no letreiro' },
      { id: 'corq_2', title: '2 cores', description: 'Duas cores no letreiro' },
      { id: 'corq_3', title: '3 cores', description: 'Três cores no letreiro' },
      { id: 'corq_4', title: '4 cores', description: 'Quatro cores no letreiro' },
      { id: 'corq_5', title: '5 cores', description: 'Cinco cores no letreiro' },
      { id: 'corq_voltar', title: 'Voltar', description: 'Retornar à etapa anterior' },
    ],
  },
  espessuraPersonalizada: {
    title: 'Espessura',
    description: '🔳\nSelecione a espessura do acrílico personalizado:',
    buttonText: 'Selecionar',
    interactiveOnly: true,
    rows: [
      { id: 'esp_4', title: 'Quero 4mm', description: 'Escolher espessura de 4mm' },
      { id: 'esp_6', title: 'Quero 6mm', description: 'Escolher espessura de 6mm' },
      { id: 'esp_10', title: 'Quero 10mm', description: 'Escolher espessura de 10mm' },
      { id: 'esp_nao_sei', title: 'Ainda não sei', description: 'Registrar para definir depois' },
      { id: 'esp_voltar', title: 'Quero voltar', description: 'Corrigir minha medida' },
    ],
  },
  arte: {
    title: 'Arte do letreiro',
    description: '🖼️\nAgora preciso da arte do seu letreiro:',
    buttonText: 'Escolher opção',
    interactiveOnly: true,
    rows: [
      { id: 'art_arquivo', title: 'Tenho arquivo', description: 'PDF, AI, EPS ou SVG' },
      { id: 'art_imagem', title: 'Enviar imagem', description: 'Imagem de referência' },
      { id: 'art_ideia', title: 'Descrever ideia', description: 'Explique como imagina o letreiro' },
      { id: 'art_voltar', title: 'Voltar', description: 'Retornar à espessura' },
    ],
  },
  observacao: {
    title: 'Observação do pedido',
    description: 'Deseja fazer uma observação sobre o pedido?',
    buttonText: 'Escolher',
    interactiveOnly: true,
    rows: [
      { id: 'OBS_PEDIDO|ADD', title: 'Fazer observação', description: 'Adicionar detalhes importantes' },
      { id: 'OBS_PEDIDO|SKIP', title: 'Não preciso', description: 'Finalizar sem observação' },
    ],
  },
};

function buildColorTypeMenu(index, total) {
  return {
    title: 'Tipo de cor',
    description: `🎨\nEscolha o tipo da *cor ${index}* de *${total}*`,
    buttonText: 'Tipo de cor',
    interactiveOnly: true,
    rows: [
      { id: 'cor_tipo_solida', title: 'Cor sólida', description: 'Preto, branco, cinza, azul...' },
      { id: 'cor_tipo_espelhado', title: 'Cor espelhada', description: 'Dourado, prata, rosê, verde, roxo...' },
      { id: 'cor_tipo_voltar', title: 'Voltar', description: 'Retornar à quantidade de cores' },
    ],
  };
}

function buildSolidColorMenu(index, total) {
  return {
    title: 'Acrílico Cores Básicas 3mm',
    description: `🎨\nSelecione a *cor ${index}* de *${total}*`,
    buttonText: 'Selecionar cor',
    interactiveOnly: true,
    rows: [
      { id: 'cor_preto', title: 'Preto', description: 'Cor sólida (3mm)' },
      { id: 'cor_branco', title: 'Branco', description: 'Cor sólida (3mm)' },
      { id: 'cor_cinza', title: 'Cinza', description: 'Cor sólida (3mm)' },
      { id: 'cor_azul', title: 'Azul', description: 'Cor sólida (3mm)' },
      { id: 'cor_verde', title: 'Verde', description: 'Cor sólida (3mm)' },
      { id: 'cor_vermelho', title: 'Vermelho', description: 'Cor sólida (3mm)' },
      { id: 'cor_amarelo', title: 'Amarelo', description: 'Cor sólida (3mm)' },
      { id: 'cor_voltar', title: 'Voltar', description: 'Retornar ao tipo da cor' },
    ],
  };
}

function buildMirrorColorMenu(index, total) {
  return {
    title: 'Acrílico Espelhado 2mm',
    description: `🪞\nSelecione a *cor espelhada ${index}* de *${total}*`,
    buttonText: 'Selecionar cor',
    interactiveOnly: true,
    rows: [
      { id: 'cor_dourado', title: 'Dourado', description: 'Efeito espelhado (2mm)' },
      { id: 'cor_prata', title: 'Prata', description: 'Efeito espelhado (2mm)' },
      { id: 'cor_rose', title: 'Rosê', description: 'Efeito espelhado (2mm)' },
      { id: 'cor_esp_vermelho', title: 'Vermelho espelhado', description: 'Efeito espelhado (2mm)' },
      { id: 'cor_esp_verde', title: 'Verde espelhado', description: 'Efeito espelhado (2mm)' },
      { id: 'cor_esp_azul', title: 'Azul espelhado', description: 'Efeito espelhado (2mm)' },
      { id: 'cor_esp_roxo', title: 'Roxo espelhado', description: 'Efeito espelhado (2mm)' },
      { id: 'cor_voltar', title: 'Voltar', description: 'Retornar ao tipo da cor' },
    ],
  };
}

function buildDepthMenu(colors = []) {
  return {
    title: 'Espessura / profundidade',
    description: '🔳\nQuer acrescentar uma espessura maior no seu acrílico?',
    buttonText: 'Selecionar',
    interactiveOnly: true,
    rows: [
      { id: 'esp3_keep', title: buildKeepBaseTitle(colors), description: buildKeepBaseDescription(colors) },
      { id: 'esp3_add3', title: 'Acrescentar +3mm', description: 'Adicionar acrílico cristal por trás' },
      { id: 'esp3_add6', title: 'Acrescentar +6mm', description: 'Adicionar acrílico cristal por trás' },
      { id: 'esp3_add10', title: 'Acrescentar +10mm', description: 'Adicionar acrílico cristal por trás' },
      { id: 'esp3_align', title: 'Ainda não sei', description: 'Registrar para definir depois' },
      { id: 'esp3_back', title: 'Quero voltar', description: 'Corrigir minha medida' },
    ],
  };
}

function buildDeliveryMenu(isGrandeBH) {
  const rows = [
    { id: 'envio_correios', title: 'Correios', description: 'Receber no meu endereço' },
  ];
  if (isGrandeBH) rows.push({ id: 'envio_instalacao', title: 'Instalação pela equipe', description: 'Disponível para BH e região' });
  rows.push(
    { id: 'envio_retirada_cliente', title: 'Retirar na empresa', description: 'Quero retirar na empresa' },
    { id: 'envio_voltar', title: 'Voltar', description: 'Corrigir minha cidade' },
  );
  return {
    title: 'Envio',
    description: '🚚\nOpções de envio\nSelecione uma opção na lista abaixo:',
    buttonText: 'Escolher Envio',
    interactiveOnly: true,
    rows,
  };
}

function buildListPayload(menu) {
  const sections = Array.isArray(menu.sections) && menu.sections.length
    ? menu.sections
    : [{ title: menu.title, rows: menu.rows || [] }];
  return {
    buttonText: menu.buttonText || 'Escolher',
    description: menu.description,
    sections: sections.map((section) => ({
      title: section.title || menu.title || 'Opções',
      rows: (section.rows || []).map((row) => ({
        rowId: row.id,
        id: row.id,
        title: row.title,
        description: row.description || '',
      })),
    })),
  };
}

function registerOutboundList(channel, clientId, menu) {
  return channel?.outboundTracker?.register(clientId, {
    type: 'list',
    text: menu?.description || menu?.title || '',
  }) || null;
}

function confirmOutboundList(channel, pending, result) {
  channel?.outboundTracker?.confirm?.(pending, result);
}

function failOutboundList(channel, pending) {
  channel?.outboundTracker?.fail?.(pending);
}

async function trySendWppList(channel, clientId, menu) {
  const client = channel?.client;
  if (!client) return false;
  const chatId = normalizeChatId(clientId);
  const payload = buildListPayload(menu);

  const attempts = [
    async () => {
      if (typeof client.sendListMessage !== 'function') return false;
      const pending = registerOutboundList(channel, clientId, menu);
      try {
        const result = await client.sendListMessage(chatId, payload);
        confirmOutboundList(channel, pending, result);
        return true;
      } catch (err) {
        failOutboundList(channel, pending);
        throw err;
      }
    },
    async () => {
      if (typeof client.sendList !== 'function') return false;
      const pending = registerOutboundList(channel, clientId, menu);
      try {
        const result = await client.sendList(chatId, menu.description, menu.buttonText || 'Escolher', payload.sections, 'Selecione uma opção');
        confirmOutboundList(channel, pending, result);
        return true;
      } catch (err) {
        failOutboundList(channel, pending);
        throw err;
      }
    },
  ];

  for (const attempt of attempts) {
    try {
      if (await attempt()) {
        console.log(`[MENU] enviado como lista interativa: ${menu.title}`);
        return true;
      }
    } catch (err) {
      console.warn(`[MENU] lista interativa falhou (${menu.title}):`, err?.message || err);
    }
  }
  return false;
}

async function sendMenu(channel, clientId, menuKeyOrDefinition, options = {}) {
  const menu = typeof menuKeyOrDefinition === 'string' ? menus[menuKeyOrDefinition] : menuKeyOrDefinition;
  if (!menu) return false;

  const interactiveOnly = options.interactiveOnly !== undefined
    ? Boolean(options.interactiveOnly)
    : Boolean(menu.interactiveOnly);
  const attempts = interactiveOnly ? 2 : 1;

  for (let i = 0; i < attempts; i += 1) {
    if (await trySendWppList(channel, clientId, menu)) return true;
    if (i + 1 < attempts) await wait(350);
  }

  if (interactiveOnly) {
    const error = new Error(`Não foi possível abrir a lista interativa: ${menu.title}`);
    error.code = 'interactive_list_required';
    throw error;
  }

  if (menu.fallbackText) {
    await channel.sendText(clientId, menu.fallbackText);
    return true;
  }
  return false;
}

module.exports = {
  menus,
  sendMenu,
  buildListPayload,
  buildColorTypeMenu,
  buildSolidColorMenu,
  buildMirrorColorMenu,
  buildDepthMenu,
  buildDeliveryMenu,
};
