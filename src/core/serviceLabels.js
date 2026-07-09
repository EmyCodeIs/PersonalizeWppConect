'use strict';

const { env } = require('../config/env');

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function getServiceLabel(service) {
  if (service === 'letreiro') {
    return { name: env.serviceLabelLetreiro, color: env.serviceLabelLetreiroColor };
  }
  if (service === 'plotagem') {
    return { name: env.serviceLabelPlotagem, color: env.serviceLabelPlotagemColor };
  }
  return { name: env.serviceLabelOutros, color: env.serviceLabelOutrosColor };
}

function labelId(label) {
  return label?.id || label?.labelId || label?.hexColor || label?.name || label?.label || null;
}

function labelName(label) {
  return label?.name || label?.label || label?.title || '';
}

async function getLabelsFromClient(client) {
  const methods = ['getAllLabels', 'getLabels'];
  for (const method of methods) {
    if (typeof client?.[method] !== 'function') continue;
    try {
      const labels = await client[method]();
      return Array.isArray(labels) ? labels : Object.values(labels || {});
    } catch (_) {}
  }
  return [];
}

async function getLabelsFromPage(client) {
  if (!client?.page?.evaluate) return [];
  try {
    return await client.page.evaluate(() => {
      const WPP = window.WPP || null;
      if (!WPP) return [];
      const maybe = WPP.labels?.getAllLabels?.() || WPP.label?.getAllLabels?.() || [];
      if (Array.isArray(maybe)) return maybe;
      return Object.values(maybe || {});
    });
  } catch (_) {
    return [];
  }
}

async function getAllLabels(client) {
  const fromClient = await getLabelsFromClient(client);
  if (fromClient.length) return fromClient;
  const fromPage = await getLabelsFromPage(client);
  return Array.isArray(fromPage) ? fromPage : [];
}

async function createLabel(client, name, color) {
  if (!name) return null;

  const attempts = [
    async () => {
      if (typeof client?.createLabel !== 'function') return null;
      return client.createLabel(name, color);
    },
    async () => {
      if (!client?.page?.evaluate) return null;
      return client.page.evaluate(async ({ name, color }) => {
        const WPP = window.WPP || null;
        if (!WPP) return null;
        if (WPP.labels?.create) return WPP.labels.create(name, { color });
        if (WPP.label?.create) return WPP.label.create(name, { color });
        if (WPP.labels?.addLabel) return WPP.labels.addLabel(name, color);
        return null;
      }, { name, color });
    },
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) return result;
    } catch (_) {}
  }
  return null;
}

async function findOrCreateLabel(client, name, color) {
  const labels = await getAllLabels(client);
  const found = labels.find((label) => normalizeName(labelName(label)) === normalizeName(name));
  if (found) return found;
  const created = await createLabel(client, name, color);
  if (created) return created;
  return { id: name, name };
}

async function resolveLabelIds(client, names = []) {
  const labels = await getAllLabels(client);
  const wanted = names.map(normalizeName).filter(Boolean);
  return labels
    .filter((label) => wanted.includes(normalizeName(labelName(label))))
    .map(labelId)
    .filter(Boolean);
}

async function addLabels(client, chatId, labelIds = []) {
  if (!labelIds.length) return false;
  const attempts = [
    async () => {
      if (typeof client?.addOrRemoveLabels !== 'function') return false;
      await client.addOrRemoveLabels([chatId], labelIds, []);
      return true;
    },
    async () => {
      if (typeof client?.addChatWLabels !== 'function') return false;
      await client.addChatWLabels(chatId, labelIds);
      return true;
    },
    async () => {
      if (typeof client?.addLabelToChat !== 'function') return false;
      for (const id of labelIds) await client.addLabelToChat(chatId, id);
      return true;
    },
    async () => {
      if (!client?.page?.evaluate) return false;
      return client.page.evaluate(async ({ chatId, labelIds }) => {
        const WPP = window.WPP || null;
        if (!WPP) return false;
        if (WPP.chat?.addLabels) {
          await WPP.chat.addLabels(chatId, labelIds);
          return true;
        }
        if (WPP.labels?.addChatLabels) {
          await WPP.labels.addChatLabels(chatId, labelIds);
          return true;
        }
        if (WPP.label?.addChatLabels) {
          await WPP.label.addChatLabels(chatId, labelIds);
          return true;
        }
        return false;
      }, { chatId, labelIds });
    },
  ];

  for (const attempt of attempts) {
    try {
      const ok = await attempt();
      if (ok) return true;
    } catch (_) {}
  }
  return false;
}

async function removeLabels(client, chatId, labelIds = []) {
  if (!labelIds.length) return true;
  const attempts = [
    async () => {
      if (typeof client?.addOrRemoveLabels !== 'function') return false;
      await client.addOrRemoveLabels([chatId], [], labelIds);
      return true;
    },
    async () => {
      if (typeof client?.removeChatWLabels !== 'function') return false;
      await client.removeChatWLabels(chatId, labelIds);
      return true;
    },
    async () => {
      if (typeof client?.removeLabelFromChat !== 'function') return false;
      for (const id of labelIds) await client.removeLabelFromChat(chatId, id);
      return true;
    },
    async () => {
      if (!client?.page?.evaluate) return false;
      return client.page.evaluate(async ({ chatId, labelIds }) => {
        const WPP = window.WPP || null;
        if (!WPP) return false;
        if (WPP.chat?.removeLabels) {
          await WPP.chat.removeLabels(chatId, labelIds);
          return true;
        }
        if (WPP.labels?.removeChatLabels) {
          await WPP.labels.removeChatLabels(chatId, labelIds);
          return true;
        }
        if (WPP.label?.removeChatLabels) {
          await WPP.label.removeChatLabels(chatId, labelIds);
          return true;
        }
        return false;
      }, { chatId, labelIds });
    },
  ];

  for (const attempt of attempts) {
    try {
      const ok = await attempt();
      if (ok) return true;
    } catch (_) {}
  }
  return false;
}

async function replaceServiceLabel(channel, clientId, service) {
  if (!env.enableContactLabels || !channel?.client) return false;

  const client = channel.client;
  const chatId = normalizeChatId(clientId);
  const target = getServiceLabel(service);
  if (!chatId || !target?.name) return false;

  const replaceGroup = env.serviceLabelReplaceGroup?.length
    ? env.serviceLabelReplaceGroup
    : [env.serviceLabelLetreiro, env.serviceLabelPlotagem, env.serviceLabelOutros];

  const targetLabel = await findOrCreateLabel(client, target.name, target.color);
  const targetId = labelId(targetLabel) || target.name;
  const removeIds = await resolveLabelIds(client, replaceGroup);

  const removed = await removeLabels(client, chatId, removeIds);
  if (!removed && removeIds.length) {
    console.warn(`[ETIQUETA] não consegui remover etiquetas antigas de ${chatId}. Vou tentar aplicar a nova mesmo assim.`);
  }

  const added = await addLabels(client, chatId, [targetId]);
  if (added) {
    console.log(`[ETIQUETA] aplicada: ${target.name} (${target.color}) em ${chatId}`);
    return true;
  }

  console.warn(`[ETIQUETA] não consegui aplicar ${target.name} em ${chatId}. Verifique suporte da versão/sessão Business.`);
  return false;
}

module.exports = {
  replaceServiceLabel,
  getServiceLabel,
  normalizeChatId,
};
