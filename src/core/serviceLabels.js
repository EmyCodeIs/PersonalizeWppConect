'use strict';

const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');

let initializationPromise = null;
let initializationFinished = false;
const resolvedLabels = new Map();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function labelId(label) {
  return String(label?.id || label?.labelId || '').trim();
}

function labelName(label) {
  return String(label?.name || label?.label || '').trim();
}

function labelColorIndex(label) {
  const raw = label?.colorIndex ?? label?.colorId ?? label?.color;
  return Number.isFinite(Number(raw)) ? Number(raw) : null;
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

function serviceTargets() {
  return [
    getServiceLabel('letreiro'),
    getServiceLabel('plotagem'),
    getServiceLabel('outros'),
  ].filter((item) => item?.name);
}

function managedServiceLabelNames() {
  const configured = Array.isArray(env.serviceLabelReplaceGroup)
    ? env.serviceLabelReplaceGroup
    : [];
  const fallback = serviceTargets().map((item) => item.name);
  return [...new Set((configured.length ? configured : fallback)
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

async function getAllLabels(client) {
  if (typeof client?.getAllLabels !== 'function') return [];
  try {
    const value = await client.getAllLabels();
    return Array.isArray(value) ? value : Object.values(value || {});
  } catch (err) {
    console.warn('[ETIQUETAS] não foi possível listar etiquetas:', err?.message || err);
    return [];
  }
}

async function getAllLabelsStable(client, attempts = 5, delayMs = 500) {
  let labels = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    labels = await getAllLabels(client);
    if (labels.length) return labels;
    if (attempt < attempts) await wait(delayMs);
  }
  return labels;
}

function compareIds(a, b) {
  const aId = labelId(a);
  const bId = labelId(b);
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function findCanonicalLabel(labels, targetName) {
  const wanted = normalizeName(targetName);
  const matches = labels
    .filter((item) => normalizeName(labelName(item)) === wanted)
    .filter((item) => labelId(item));

  if (!matches.length) return null;

  // As duplicatas criadas pelas versões defeituosas são mais novas.
  // O menor ID corresponde à etiqueta original na conta.
  const canonical = [...matches].sort(compareIds)[0];

  if (matches.length > 1) {
    console.warn(
      `[ETIQUETAS] duplicatas encontradas para "${targetName}": ${matches.map(labelId).join(', ')}. `
      + `Usando somente a etiqueta original de ID ${labelId(canonical)}.`,
    );
  }

  return canonical;
}

async function resolveExistingLabel(client, target, options = {}) {
  const key = normalizeName(target?.name);
  if (!key) return null;

  if (!options.refresh && resolvedLabels.has(key)) {
    return resolvedLabels.get(key);
  }

  const labels = await getAllLabelsStable(
    client,
    options.attempts || 4,
    options.delayMs || 500,
  );
  const canonical = findCanonicalLabel(labels, target.name);

  if (canonical) {
    resolvedLabels.set(key, canonical);
    console.log(`[ETIQUETAS] reutilizando etiqueta existente: ${labelName(canonical)} | ID ${labelId(canonical)}`);
  }

  return canonical;
}

async function createMissingLabelOnce(client, target) {
  const existing = await resolveExistingLabel(client, target, {
    refresh: true,
    attempts: 6,
    delayMs: 600,
  });
  if (existing) return existing;

  if (typeof client?.addNewLabel !== 'function') {
    console.warn(`[ETIQUETAS] "${target.name}" não existe e a criação oficial está indisponível.`);
    return null;
  }

  console.log(`[ETIQUETAS] etiqueta ausente; criando uma única vez pela API oficial: ${target.name}`);
  try {
    await client.addNewLabel(target.name, {
      labelColor: String(target.color || '').trim() || undefined,
    });
  } catch (err) {
    console.warn(`[ETIQUETAS] falha ao criar "${target.name}":`, err?.message || err);
    return null;
  }

  await wait(1200);
  return resolveExistingLabel(client, target, {
    refresh: true,
    attempts: 8,
    delayMs: 600,
  });
}

async function initializeServiceLabels(channel) {
  if (!env.enableContactLabels || !channel?.client) return false;
  if (initializationFinished) return true;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    console.log('[ETIQUETAS] verificando etiquetas existentes uma única vez...');
    await wait(1000);

    let ready = true;
    for (const target of serviceTargets()) {
      const label = await createMissingLabelOnce(channel.client, target);
      if (!label) {
        ready = false;
        console.warn(`[ETIQUETAS] não foi possível preparar: ${target.name}`);
        continue;
      }
      console.log(`[ETIQUETAS] pronta para reutilização: ${target.name} | ID ${labelId(label)}`);
    }

    // Mesmo que uma etiqueta falhe, não tenta criá-la repetidamente durante atendimentos.
    initializationFinished = true;
    return ready;
  })().finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

function uniqueLabelMetadata(labels = []) {
  const seen = new Set();
  return labels
    .map((item) => ({
      id: labelId(item) || null,
      name: labelName(item),
      colorIndex: labelColorIndex(item),
    }))
    .filter((item) => item.name)
    .filter((item) => {
      const key = `${item.id || ''}:${normalizeName(item.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function detectAttachedLabels(client, chatId, managedNames = managedServiceLabelNames()) {
  if (!env.detectManualContactLabels || !client?.page?.evaluate || !chatId) {
    return { all: [], manual: [], managed: [] };
  }

  try {
    const result = await client.page.evaluate(async ({ chatId, managedNames }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const managedSet = new Set((managedNames || []).map(normalize));

      let allLabels = [];
      try {
        if (WPP?.labels?.getAllLabels) {
          const value = await WPP.labels.getAllLabels();
          allLabels = Array.isArray(value) ? value : Object.values(value || {});
        }
      } catch (_) {}

      let chat = null;
      try {
        chat = Store?.Chat?.get?.(chatId) || null;
        if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
      } catch (_) {}

      let attached = [];
      try {
        const labelStore = Store?.Label || Store?.Labels || null;
        if (chat && typeof labelStore?.getLabelsForModel === 'function') {
          const value = labelStore.getLabelsForModel(chat) || [];
          attached = Array.isArray(value) ? value : Object.values(value || {});
        } else if (Array.isArray(chat?.labels)) {
          attached = chat.labels;
        } else if (Array.isArray(chat?.labelIds)) {
          attached = chat.labelIds;
        }
      } catch (_) {}

      const normalized = attached.map((item) => {
        const rawId = item?.id || item?.labelId || item;
        const id = rawId ? String(rawId) : '';
        const known = allLabels.find((label) => String(label?.id || label?.labelId || '') === id) || null;
        const name = String(item?.name || item?.label || known?.name || known?.label || '').trim();
        const color = item?.colorIndex ?? item?.colorId ?? item?.color
          ?? known?.colorIndex ?? known?.colorId ?? known?.color;
        return {
          id: id || null,
          name,
          colorIndex: Number.isFinite(Number(color)) ? Number(color) : null,
        };
      }).filter((item) => item.name);

      return {
        all: normalized,
        manual: normalized.filter((item) => !managedSet.has(normalize(item.name))),
        managed: normalized.filter((item) => managedSet.has(normalize(item.name))),
      };
    }, { chatId, managedNames });

    return {
      all: uniqueLabelMetadata(result?.all || []),
      manual: uniqueLabelMetadata(result?.manual || []),
      managed: uniqueLabelMetadata(result?.managed || []),
    };
  } catch (err) {
    console.warn(`[ETIQUETAS] não foi possível identificar etiquetas de ${chatId}:`, err?.message || err);
    return { all: [], manual: [], managed: [] };
  }
}

function persistManualLabels(clientId, labels = []) {
  if (!env.storeManualContactLabels) return;
  try {
    const session = Store.getSession(clientId);
    if (!session) return;
    session.dados = session.dados || {};
    const normalized = uniqueLabelMetadata(labels)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    session.dados.manualContactLabels = normalized;
    session.dados.manualContactLabelNames = normalized.map((item) => item.name);
    session.dados.manualContactLabelsDetectedAt = new Date().toISOString();
    Store.saveSession(session);
  } catch (err) {
    console.warn('[ETIQUETAS] não foi possível salvar etiquetas manuais:', err?.message || err);
  }
}

async function addLabelById(client, chatId, id) {
  if (typeof client?.addOrRemoveLabels !== 'function') return false;
  await client.addOrRemoveLabels([chatId], [{ labelId: String(id), type: 'add' }]);
  return true;
}

async function replaceServiceLabel(channel, clientId, service) {
  if (!env.enableContactLabels || !channel?.client) return false;

  if (!initializationFinished) await initializeServiceLabels(channel);

  const client = channel.client;
  const target = getServiceLabel(service);
  if (!target?.name) return false;

  // Nunca cria etiqueta dentro do atendimento. Apenas reutiliza a existente.
  let label = await resolveExistingLabel(client, target);
  if (!label) {
    label = await resolveExistingLabel(client, target, {
      refresh: true,
      attempts: 4,
      delayMs: 500,
    });
  }
  if (!label?.id) {
    console.warn(`[ETIQUETAS] etiqueta existente não localizada durante atendimento: ${target.name}`);
    return false;
  }

  const managedNames = managedServiceLabelNames();
  const candidates = Identity.getLabelCandidateIds(clientId);
  if (!candidates.length) candidates.push(Identity.normalizeChatId(clientId));

  for (const chatId of [...new Set(candidates.filter(Boolean))]) {
    const before = await detectAttachedLabels(client, chatId, managedNames);
    if (before.manual.length) persistManualLabels(clientId, before.manual);

    try {
      const applied = await addLabelById(client, chatId, labelId(label));
      if (!applied) continue;

      await wait(400);
      const after = await detectAttachedLabels(client, chatId, managedNames);
      const manualLabels = after.manual.length ? after.manual : before.manual;
      persistManualLabels(clientId, manualLabels);

      console.log(
        `[ETIQUETAS] etiqueta original reutilizada sem remover outras: `
        + `${labelName(label)} | ID ${labelId(label)} | ${chatId}`,
      );
      return {
        applied: true,
        mode: 'official-existing-label',
        chatId,
        targetId: labelId(label),
        targetName: labelName(label),
        manualLabels,
        managedLabels: after.managed,
      };
    } catch (err) {
      console.warn(`[ETIQUETAS] falha ao anexar ${target.name} em ${chatId}:`, err?.message || err);
    }
  }

  console.warn(`[ETIQUETAS] não foi possível anexar ${target.name} ao contato.`);
  return false;
}

module.exports = {
  initializeServiceLabels,
  replaceServiceLabel,
  detectAttachedLabels,
  managedServiceLabelNames,
  getServiceLabel,
  normalizeChatId: Identity.normalizeChatId,
};
