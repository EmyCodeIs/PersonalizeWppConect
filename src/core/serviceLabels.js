'use strict';

const { env } = require('../config/env');

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function toWhatsAppNumber(value) {
  let digits = onlyDigits(value);
  if (!digits) return '';

  // Mapeamentos locais brasileiros podem vir sem DDI.
  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  return digits;
}

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';

  if (/@lid$/i.test(raw)) {
    const mapped = env.lidNumberMap?.[raw.toLowerCase()];
    const number = toWhatsAppNumber(mapped);
    if (number) {
      const resolved = `${number}@c.us`;
      console.log(`[ETIQUETA] LID resolvido para aplicação: ${raw} -> ${resolved}`);
      return resolved;
    }

    console.warn(`[ETIQUETA] não existe LID_NUMBER_MAP para ${raw}; etiqueta não será aplicada pelo @lid.`);
    return '';
  }

  if (/@c\.us$/i.test(raw)) return raw;
  if (/@g\.us$/i.test(raw)) return '';

  const number = toWhatsAppNumber(raw);
  return number ? `${number}@c.us` : '';
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
    await client.addNewLabel(name, {
      labelColor: colorToHex(color),
    });

    labels = await getAllLabels(client);
    found = labels.find((label) => normalizeName(labelName(label)) === normalizeName(name));
    return found || null;
  } catch (err) {
    console.warn(`[ETIQUETA] não foi possível criar "${name}":`, err?.message || err);
    return null;
  }
}

async function replaceWithCurrentApi(client, chatId, target, replaceGroup) {
  if (typeof client?.addOrRemoveLabels !== 'function') return false;

  let labels = await getAllLabels(client);
  let targetLabel = labels.find((label) => normalizeName(labelName(label)) === normalizeName(target.name));
  if (!targetLabel) {
    targetLabel = await findOrCreateLabel(client, target.name, target.color);
    labels = await getAllLabels(client);
  }

  const targetId = labelId(targetLabel);
  if (!targetId) return false;

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

  await client.addOrRemoveLabels([chatId], options);
  return true;
}

async function replaceWithPageFallback(client, chatId, target, replaceGroup) {
  if (!client?.page?.evaluate) return false;

  try {
    return await client.page.evaluate(async ({ chatId, targetName, replaceGroup }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getAllLabels || !WPP.labels?.addOrRemoveLabels) return false;

      const labels = await WPP.labels.getAllLabels();
      const list = Array.isArray(labels) ? labels : Object.values(labels || {});
      const normalizedGroup = replaceGroup.map((name) => String(name || '').trim().toLowerCase());
      const target = list.find((label) => String(label?.name || '').trim().toLowerCase() === targetName.toLowerCase());
      if (!target?.id) return false;

      const options = list
        .filter((label) => normalizedGroup.includes(String(label?.name || '').trim().toLowerCase()))
        .map((label) => ({
          labelId: String(label.id),
          type: String(label.id) === String(target.id) ? 'add' : 'remove',
        }));

      if (!options.some((item) => item.type === 'add')) {
        options.push({ labelId: String(target.id), type: 'add' });
      }

      await WPP.labels.addOrRemoveLabels([chatId], options);
      return true;
    }, {
      chatId,
      targetName: target.name,
      replaceGroup,
    });
  } catch (err) {
    console.warn('[ETIQUETA] fallback interno falhou:', err?.message || err);
    return false;
  }
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

  let ok = false;
  try {
    ok = await replaceWithCurrentApi(client, chatId, target, replaceGroup);
  } catch (err) {
    console.warn(`[ETIQUETA] API atual falhou para ${target.name}:`, err?.message || err);
  }

  if (!ok) ok = await replaceWithPageFallback(client, chatId, target, replaceGroup);

  if (ok) {
    console.log(`[ETIQUETA] solicitação enviada: ${target.name} (${target.color}) em ${chatId}`);
    return true;
  }

  console.warn(`[ETIQUETA] não consegui aplicar ${target.name} em ${chatId}.`);
  return false;
}

module.exports = {
  replaceServiceLabel,
  getServiceLabel,
  normalizeChatId,
};
