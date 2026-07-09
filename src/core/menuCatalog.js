'use strict';

const { messages } = require('./messages');

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

const menus = {
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
    description: 'Qual tipo de acrílico você deseja?',
    buttonText: 'Ver tipos',
    fallbackText: messages.askAcrylicType,
    rows: [
      { id: '1', title: 'Colorido', description: 'Cores sólidas: preto, branco, dourado, prata...' },
      { id: '2', title: 'Personalizado / Pantone', description: 'Envie sua cor, código ou referência' },
    ],
  },
  quantidadeCores: {
    title: 'Quantidade de cores',
    description: 'Quantas cores terá seu letreiro?',
    buttonText: 'Escolher quantidade',
    fallbackText: messages.askColorCount,
    rows: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), title: `${n} ${n === 1 ? 'cor' : 'cores'}` })),
  },
  profundidade: {
    title: 'Espessura / profundidade',
    description: 'Deseja seguir com 3mm ou adicionar acrílico cristal por trás?',
    buttonText: 'Escolher espessura',
    fallbackText: messages.askDepth,
    rows: [
      { id: '1', title: 'Seguir com 3mm', description: 'Sem acréscimo de cristal' },
      { id: '2', title: '+3mm', description: 'Acrílico cristal por trás' },
      { id: '3', title: '+6mm', description: 'Acrílico cristal por trás' },
      { id: '4', title: '+10mm', description: 'Acrílico cristal por trás' },
    ],
  },
  espessuraPersonalizada: {
    title: 'Espessura personalizada',
    description: 'Qual espessura deseja para o acrílico personalizado?',
    buttonText: 'Escolher espessura',
    fallbackText: messages.askPersonalizedThickness,
    rows: [
      { id: '1', title: '4mm' },
      { id: '2', title: '6mm' },
      { id: '3', title: '10mm' },
    ],
  },
  arte: {
    title: 'Arte do letreiro',
    description: 'Agora preciso da arte do seu letreiro.',
    buttonText: 'Escolher opção',
    fallbackText: messages.askArt,
    rows: [
      { id: '1', title: 'Tenho arquivo', description: 'PDF, AI, EPS ou SVG' },
      { id: '2', title: 'Enviar imagem', description: 'Imagem de referência' },
      { id: '3', title: 'Descrever ideia', description: 'Explique como imagina o letreiro' },
    ],
  },
  envio: {
    title: 'Forma de recebimento',
    description: 'Como deseja receber?',
    buttonText: 'Escolher envio',
    fallbackText: messages.askDelivery,
    rows: [
      { id: '1', title: 'Correios / transportadora' },
      { id: '2', title: 'Instalação', description: 'BH e região' },
      { id: '3', title: 'Retirada' },
    ],
  },
};

function buildListPayload(menu) {
  return {
    buttonText: menu.buttonText || 'Escolher',
    description: menu.description,
    sections: [
      {
        title: menu.title,
        rows: menu.rows.map((row) => ({
          rowId: row.id,
          id: row.id,
          title: row.title,
          description: row.description || '',
        })),
      },
    ],
  };
}

async function trySendWppList(channel, clientId, menu) {
  const client = channel?.client;
  if (!client) return false;
  const chatId = normalizeChatId(clientId);
  const payload = buildListPayload(menu);

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
      if (typeof client.sendButtons !== 'function') return false;
      if (menu.rows.length > 3) return false;
      const buttons = menu.rows.map((row) => ({ buttonId: row.id, buttonText: { displayText: row.title }, type: 1 }));
      await client.sendButtons(chatId, menu.description, buttons, menu.title);
      return true;
    },
  ];

  for (const attempt of attempts) {
    try {
      const ok = await attempt();
      if (ok) {
        console.log(`[MENU] enviado como interativo: ${menu.title}`);
        return true;
      }
    } catch (err) {
      console.warn(`[MENU] interativo falhou (${menu.title}):`, err?.message || err);
    }
  }

  return false;
}

async function sendMenu(channel, clientId, menuKey) {
  const menu = menus[menuKey];
  if (!menu) return;

  if (channel?.sendMenu) {
    const sent = await channel.sendMenu(clientId, menu).catch((err) => {
      console.warn(`[MENU] falha ao enviar lista "${menuKey}":`, err?.message || err);
      return false;
    });
    if (sent) return;
  }

  const sentByClient = await trySendWppList(channel, clientId, menu);
  if (sentByClient) return;

  console.log(`[MENU] usando fallback texto: ${menu.title}`);
  await channel.sendText(clientId, menu.fallbackText);
}

module.exports = { menus, sendMenu };
