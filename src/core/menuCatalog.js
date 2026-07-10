'use strict';

const { messages } = require('./messages');

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
    rows: [
      { id: '1', title: 'Letreiro de acrílico', description: 'Orçamento de letreiro e cores' },
      { id: '2', title: 'Plotagem', description: 'Encaminhar para vendedor' },
      { id: '3', title: 'Outros', description: 'Encaminhar para vendedor' },
    ],
  },
  confirmarFluxo: {
    title: 'Tipo de orçamento',
    description: 'Para eu te atender melhor, seu orçamento é para letreiro em acrílico?',
    buttonText: 'Escolher opção',
    fallbackText: messages.askFlow,
    rows: [
      { id: '1', title: 'Sim, quero letreiro', description: 'Seguir orçamento de letreiro em acrílico' },
      { id: '2', title: 'Não, é outro serviço', description: 'Encaminhar para atendimento humano' },
    ],
  },
  tipoAcrilico: {
    title: 'Tipo de acrílico',
    description: '🔶\nSelecione o tipo de acrílico do seu letreiro:',
    buttonText: 'Selecionar Acrílico',
    fallbackText: messages.askAcrylicType,
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
    rows: [
      { id: 'corq_1', title: '1 cor', description: 'Uma cor no letreiro' },
      { id: 'corq_2', title: '2 cores', description: 'Duas cores no letreiro' },
      { id: 'corq_3', title: '3 cores', description: 'Três cores no letreiro' },
      { id: 'corq_4', title: '4 cores', description: 'Quatro cores no letreiro' },
      { id: 'corq_5', title: '5 cores', description: 'Cinco cores no letreiro' },
      { id: 'corq_voltar', title: 'Voltar', description: 'Retornar à etapa anterior' },
    ],
  },
  profundidade: {
    title: 'Espessura / profundidade',
    description: 'Deseja seguir com 3mm ou adicionar acrílico cristal por trás?',
    buttonText: 'Escolher espessura',
    fallbackText: messages.askDepth,
    rows: [
      { id: 'esp3_keep', title: 'Quero manter 3mm', description: 'Seguir com a espessura padrão' },
      { id: 'esp3_add3', title: 'Acrescentar +3mm', description: 'Adicionar acrílico cristal por trás' },
      { id: 'esp3_add6', title: 'Acrescentar +6mm', description: 'Adicionar acrílico cristal por trás' },
      { id: 'esp3_add10', title: 'Acrescentar +10mm', description: 'Adicionar acrílico cristal por trás' },
    ],
  },
  espessuraPersonalizada: {
    title: 'Espessura personalizada',
    description: 'Qual espessura deseja para o acrílico personalizado?',
    buttonText: 'Escolher espessura',
    fallbackText: messages.askPersonalizedThickness,
    rows: [
      { id: 'esp_4', title: '4mm' },
      { id: 'esp_6', title: '6mm' },
      { id: 'esp_10', title: '10mm' },
    ],
  },
  arte: {
    title: 'Arte do letreiro',
    description: 'Agora preciso da arte do seu letreiro.',
    buttonText: 'Escolher opção',
    fallbackText: messages.askArt,
    rows: [
      { id: 'art_arquivo', title: 'Tenho arquivo', description: 'PDF, AI, EPS ou SVG' },
      { id: 'art_imagem', title: 'Enviar imagem', description: 'Imagem de referência' },
      { id: 'art_ideia', title: 'Descrever ideia', description: 'Explique como imagina o letreiro' },
    ],
  },
  envio: {
    title: 'Forma de recebimento',
    description: 'Como deseja receber?',
    buttonText: 'Escolher envio',
    fallbackText: messages.askDelivery,
    rows: [
      { id: 'envio_correios', title: 'Correios / transportadora' },
      { id: 'envio_instalacao', title: 'Instalação', description: 'BH e região' },
      { id: 'envio_retirada', title: 'Retirada' },
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
      { id: 'cor_voltar', title: 'Voltar', description: 'Retornar à etapa anterior' },
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
      { id: 'cor_voltar', title: 'Voltar', description: 'Retornar à etapa anterior' },
    ],
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

async function trySendWppList(channel, clientId, menu) {
  const client = channel?.client;
  if (!client) return false;
  const chatId = normalizeChatId(clientId);
  const payload = buildListPayload(menu);
  const rows = payload.sections.flatMap((section) => section.rows || []);

  const attempts = [
    async () => {
      if (typeof client.sendListMessage !== 'function') return false;
      await client.sendListMessage(chatId, payload);
      return true;
    },
    async () => {
      if (typeof client.sendList !== 'function') return false;
      await client.sendList(chatId, menu.description, menu.buttonText || 'Escolher', payload.sections, 'Selecione uma opção');
      return true;
    },
    async () => {
      if (typeof client.sendButtons !== 'function' || rows.length > 3) return false;
      const buttons = rows.map((row) => ({ buttonId: row.id, buttonText: { displayText: row.title }, type: 1 }));
      await client.sendButtons(chatId, menu.description, buttons, menu.title);
      return true;
    },
  ];

  for (const attempt of attempts) {
    try {
      if (await attempt()) {
        console.log(`[MENU] enviado como interativo: ${menu.title}`);
        return true;
      }
    } catch (err) {
      console.warn(`[MENU] interativo falhou (${menu.title}):`, err?.message || err);
    }
  }

  return false;
}

async function sendMenu(channel, clientId, menuKeyOrDefinition, options = {}) {
  const menu = typeof menuKeyOrDefinition === 'string'
    ? menus[menuKeyOrDefinition]
    : menuKeyOrDefinition;
  if (!menu) return false;

  const interactiveOnly = Boolean(options.interactiveOnly || menu.interactiveOnly);
  const maxAttempts = interactiveOnly ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (channel?.sendMenu) {
      const sent = await channel.sendMenu(clientId, menu).catch((err) => {
        console.warn(`[MENU] falha ao enviar lista "${menu.title}" via canal:`, err?.message || err);
        return false;
      });
      if (sent) return true;
    }

    if (await trySendWppList(channel, clientId, menu)) return true;
    if (attempt < maxAttempts) await wait(450);
  }

  if (interactiveOnly) {
    const error = new Error(`Não foi possível abrir a lista interativa: ${menu.title}`);
    error.code = 'interactive_list_required';
    throw error;
  }

  if (menu.fallbackText) {
    console.log(`[MENU] usando fallback texto: ${menu.title}`);
    await channel.sendText(clientId, menu.fallbackText);
    return true;
  }

  return false;
}

module.exports = {
  menus,
  sendMenu,
  buildColorTypeMenu,
  buildSolidColorMenu,
  buildMirrorColorMenu,
};
