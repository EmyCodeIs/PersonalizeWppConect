'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');

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

function colorToHex(color) {
  const normalized = String(color || '').trim().toLowerCase();
  const map = {
    green: '#25D366',
    red: '#F15C6D',
    gray: '#A4A4A4',
    grey: '#A4A4A4',
    blue: '#53BDEB',
    yellow: '#F7D154',
    orange: '#F5A623',
    purple: '#A970FF',
    pink: '#FF8AC6',
  };
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized;
  return map[normalized] || '#A4A4A4';
}

function labelId(label) {
  return String(label?.id || label?.labelId || '').trim();
}

function labelName(label) {
  return String(label?.name || label?.label || '').trim();
}

async function getAllLabels(client) {
  if (typeof client?.getAllLabels !== 'function') return [];
  try {
    const labels = await client.getAllLabels();
    return Array.isArray(labels) ? labels : Object.values(labels || {});
  } catch (err) {
    console.warn('[ETIQUETA] não foi possível listar etiquetas:', err?.message || err);
    return [];
  }
}

async function findOrCreateLabel(client, name, color) {
  let labels = await getAllLabels(client);
  let found = labels.find((label) => normalizeName(labelName(label)) === normalizeName(name));
  if (found) return found;

  if (typeof client?.addNewLabel !== 'function') return null;

  try {
    await client.addNewLabel(name, { labelColor: colorToHex(color) });
    labels = await getAllLabels(client);
    found = labels.find((label) => normalizeName(labelName(label)) === normalizeName(name));
    return found || null;
  } catch (err) {
    console.warn(`[ETIQUETA] não foi possível criar "${name}":`, err?.message || err);
    return null;
  }
}

async function buildOptions(client, target, replaceGroup) {
  let labels = await getAllLabels(client);
  let targetLabel = labels.find((label) => normalizeName(labelName(label)) === normalizeName(target.name));
  if (!targetLabel) {
    targetLabel = await findOrCreateLabel(client, target.name, target.color);
    labels = await getAllLabels(client);
  }

  const targetId = labelId(targetLabel);
  if (!targetId) return [];

  const removableNames = new Set(replaceGroup.map(normalizeName));
  const options = labels
    .filter((label) => removableNames.has(normalizeName(labelName(label))))
    .map((label) => ({
      labelId: labelId(label),
      type: labelId(label) === targetId ? 'add' : 'remove',
    }))
    .filter((item) => item.labelId);

  if (!options.some((item) => item.labelId === targetId && item.type === 'add')) {
    options.push({ labelId: targetId, type: 'add' });
  }

  return options;
}

async function applyWithClientApi(client, chatId, options) {
  if (typeof client?.addOrRemoveLabels !== 'function' || !options.length) return false;
  await client.addOrRemoveLabels([chatId], options);
  return true;
}

async function applyWithPageApi(client, chatId, options) {
  if (!client?.page?.evaluate || !options.length) return false;
  try {
    return await client.page.evaluate(async ({ chatId, options }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.addOrRemoveLabels) return false;
      await WPP.labels.addOrRemoveLabels([chatId], options);
      return true;
    }, { chatId, options });
  } catch (_) {
    return false;
  }
}

async function replaceServiceLabel(channel, clientId, service) {
  if (!env.enableContactLabels || !channel?.client) return false;

  const client = channel.client;
  const target = getServiceLabel(service);
  if (!target?.name) return false;

  const replaceGroup = env.serviceLabelReplaceGroup?.length
    ? env.serviceLabelReplaceGroup
    : [env.serviceLabelLetreiro, env.serviceLabelPlotagem, env.serviceLabelOutros];

  const options = await buildOptions(client, target, replaceGroup);
  if (!options.length) {
    console.warn(`[ETIQUETA] não consegui localizar/criar a etiqueta ${target.name}.`);
    return false;
  }

  // O chatId recebido continua sendo a identidade principal. Para contatos LID,
  // tentamos o próprio @lid primeiro. Aliases conhecidos são apenas tentativas extras.
  const candidates = Identity.getLabelCandidateIds(clientId);
  if (!candidates.length) candidates.push(Identity.normalizeChatId(clientId));

  for (const chatId of candidates) {
    let sent = false;
    try {
      sent = await applyWithClientApi(client, chatId, options);
    } catch (err) {
      console.warn(`[ETIQUETA] API do cliente falhou para ${chatId}:`, err?.message || err);
    }

    if (!sent) sent = await applyWithPageApi(client, chatId, options);

    if (sent) {
      console.log(`[ETIQUETA] solicitação enviada para ${chatId}: ${target.name} (${target.color})`);
      return true;
    }
  }

  console.warn(`[ETIQUETA] não foi possível enviar ${target.name} para nenhum identificador conhecido do contato.`);
  return false;
}

module.exports = {
  replaceServiceLabel,
  getServiceLabel,
  normalizeChatId: Identity.normalizeChatId,
};
