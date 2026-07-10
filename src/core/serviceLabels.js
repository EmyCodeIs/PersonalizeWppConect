'use strict';

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const Identity = require('../services/contactIdentity');
const Store = require('../services/leadStore');

const DATA_DIR = path.join(process.cwd(), 'data');
const REGISTRY_PATH = path.join(DATA_DIR, 'service-labels.json');
const creationLocks = new Map();
let initializePromise = null;
let initialized = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function desiredHex(color) {
  const normalized = normalizeName(color);
  const map = {
    green: '#00a884',
    red: '#ea0038',
    gray: '#667781',
    grey: '#667781',
    blue: '#027eb5',
    yellow: '#f7b928',
    orange: '#ff7a00',
    purple: '#7f66ff',
    pink: '#ff7eb6',
  };
  return /^#[0-9a-f]{6}$/i.test(String(color || '').trim())
    ? String(color).trim()
    : (map[normalized] || '#667781');
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

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return { version: 1, labels: {}, updatedAt: null };
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return {
      version: 1,
      labels: parsed?.labels && typeof parsed.labels === 'object' ? parsed.labels : {},
      updatedAt: parsed?.updatedAt || null,
    };
  } catch (err) {
    console.warn('[ETIQUETAS] não foi possível ler o registro local:', err?.message || err);
    return { version: 1, labels: {}, updatedAt: null };
  }
}

const registry = readRegistry();

function writeRegistry() {
  try {
    ensureDataDir();
    registry.updatedAt = nowIso();
    const tempPath = `${REGISTRY_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), 'utf8');
    fs.renameSync(tempPath, REGISTRY_PATH);
  } catch (err) {
    console.warn('[ETIQUETAS] não foi possível salvar o registro local:', err?.message || err);
  }
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

function labelMetadata(label) {
  return {
    id: labelId(label) || null,
    name: labelName(label),
    colorIndex: labelColorIndex(label),
  };
}

function uniqueLabelMetadata(labels = []) {
  const seen = new Set();
  return labels
    .map(labelMetadata)
    .filter((item) => item.name)
    .filter((item) => {
      const key = `${item.id || ''}:${normalizeName(item.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getCachedLabel(target) {
  return registry.labels[normalizeName(target?.name)] || null;
}

function saveRegistryLabel(target, label) {
  const id = labelId(label);
  if (!target?.name || !id) return null;
  const saved = {
    id,
    name: labelName(label) || target.name,
    configuredName: target.name,
    configuredColor: target.color || null,
    colorIndex: labelColorIndex(label),
    updatedAt: nowIso(),
  };
  registry.labels[normalizeName(target.name)] = saved;
  writeRegistry();
  return saved;
}

function extractCreatedId(value) {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value?.id || value?.labelId || value?.result?.id || '').trim();
}

function compareLabelIds(a, b) {
  const aId = labelId(a);
  const bId = labelId(b);
  const aNumber = Number(aId);
  const bNumber = Number(bId);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return aId.localeCompare(bId);
}

function chooseCanonicalLabel(matches, cachedId = '', preferredId = '') {
  if (!matches.length) return null;
  const preferred = matches.find((item) => labelId(item) === String(preferredId || ''));
  if (preferred) return preferred;
  const cached = matches.find((item) => labelId(item) === String(cachedId || ''));
  if (cached) return cached;
  return [...matches].sort(compareLabelIds)[0];
}

async function getAllLabelsSnapshot(client) {
  if (typeof client?.getAllLabels !== 'function') {
    return { ok: false, labels: [], reason: 'getAllLabels_unavailable' };
  }
  try {
    const value = await client.getAllLabels();
    const labels = Array.isArray(value) ? value : Object.values(value || {});
    return { ok: true, labels };
  } catch (err) {
    return { ok: false, labels: [], reason: err?.message || String(err) };
  }
}

async function getAllLabelsStable(client, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 5));
  const delayMs = Math.max(100, Number(options.delayMs || 500));
  let hadSuccessfulRead = false;
  let lastLabels = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const snapshot = await getAllLabelsSnapshot(client);
    if (snapshot.ok) {
      hadSuccessfulRead = true;
      lastLabels = snapshot.labels;
      if (lastLabels.length) return { ok: true, labels: lastLabels };
    }
    if (attempt < attempts) await wait(delayMs);
  }

  return { ok: hadSuccessfulRead, labels: lastLabels };
}

function findLabelsByName(labels, name) {
  const wanted = normalizeName(name);
  return labels.filter((item) => normalizeName(labelName(item)) === wanted);
}

async function resolveExistingLabel(client, target, options = {}) {
  const snapshot = await getAllLabelsStable(client, {
    attempts: options.attempts || 3,
    delayMs: options.delayMs || 400,
  });
  if (!snapshot.ok) return null;

  const cached = getCachedLabel(target);
  const matches = findLabelsByName(snapshot.labels, target.name);
  if (!matches.length) return null;

  const canonical = chooseCanonicalLabel(matches, cached?.id);
  if (matches.length > 1) {
    console.warn(
      `[ETIQUETAS] duplicatas encontradas para "${target.name}": ${matches.map((item) => labelId(item)).join(', ')}. `
      + `Usando o ID canônico ${labelId(canonical)} sem apagar nenhuma.`,
    );
  }
  saveRegistryLabel(target, canonical);
  return canonical;
}

async function syncExistingServiceLabelColor(client, target, label) {
  const id = labelId(label);
  if (!client?.page?.evaluate || !target?.color || !id) return false;

  try {
    return await client.page.evaluate(async ({ id, requestedHex }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.getLabelColorPalette || !WPP?.labels?.getLabelById || !WPP?.labels?.editLabel) {
        return false;
      }

      const rgb = (hex) => {
        const clean = String(hex || '').replace('#', '');
        if (!/^[0-9a-f]{6}$/i.test(clean)) return null;
        return [
          parseInt(clean.slice(0, 2), 16),
          parseInt(clean.slice(2, 4), 16),
          parseInt(clean.slice(4, 6), 16),
        ];
      };

      const current = await WPP.labels.getLabelById(String(id));
      if (!current) return false;
      const palette = await WPP.labels.getLabelColorPalette();
      const wanted = rgb(requestedHex);
      if (!wanted || !Array.isArray(palette) || !palette.length) return false;

      let colorIndex;
      let bestDistance = Number.POSITIVE_INFINITY;
      palette.forEach((item, index) => {
        const candidate = rgb(item);
        if (!candidate) return;
        const distance = ((candidate[0] - wanted[0]) ** 2)
          + ((candidate[1] - wanted[1]) ** 2)
          + ((candidate[2] - wanted[2]) ** 2);
        if (distance < bestDistance) {
          bestDistance = distance;
          colorIndex = index;
        }
      });

      if (!Number.isInteger(colorIndex)) return false;
      const currentIndex = Number(current?.colorIndex ?? current?.colorId ?? current?.color);
      if (Number.isFinite(currentIndex) && currentIndex === colorIndex) return true;

      // Altera somente a cor. O nome e o ID existentes são preservados.
      await WPP.labels.editLabel(String(id), { labelColor: colorIndex });
      return true;
    }, {
      id,
      requestedHex: desiredHex(target.color),
    });
  } catch (err) {
    console.warn(`[ETIQUETAS] não foi possível ajustar a cor de "${target.name}":`, err?.message || err);
    return false;
  }
}

async function createServiceLabelOnce(client, target) {
  const key = normalizeName(target?.name);
  if (!key) return null;
  if (creationLocks.has(key)) return creationLocks.get(key);

  const task = (async () => {
    const existing = await resolveExistingLabel(client, target, { attempts: 4, delayMs: 500 });
    if (existing) return existing;

    // Confirma uma última vez antes de criar para evitar duplicatas por cache atrasado.
    await wait(1200);
    const confirmedExisting = await resolveExistingLabel(client, target, { attempts: 4, delayMs: 500 });
    if (confirmedExisting) return confirmedExisting;

    if (typeof client?.addNewLabel !== 'function') {
      console.warn(`[ETIQUETAS] "${target.name}" não existe e addNewLabel está indisponível.`);
      return null;
    }

    console.log(`[ETIQUETAS] criando uma única vez: ${target.name}`);
    let createdValue;
    try {
      createdValue = await client.addNewLabel(target.name, {
        labelColor: desiredHex(target.color),
      });
    } catch (err) {
      console.warn(`[ETIQUETAS] falha ao criar "${target.name}":`, err?.message || err);
      return null;
    }

    const createdId = extractCreatedId(createdValue);
    const afterCreate = await getAllLabelsStable(client, { attempts: 8, delayMs: 600 });
    if (!afterCreate.ok) return null;

    const matches = findLabelsByName(afterCreate.labels, target.name);
    const canonical = chooseCanonicalLabel(matches, getCachedLabel(target)?.id, createdId);
    if (!canonical) {
      console.warn(`[ETIQUETAS] "${target.name}" foi criada, mas o ID ainda não pôde ser confirmado.`);
      return null;
    }

    if (matches.length > 1) {
      console.warn(
        `[ETIQUETAS] duplicatas detectadas após criação de "${target.name}": ${matches.map((item) => labelId(item)).join(', ')}. `
        + `Usando ${labelId(canonical)} sem excluir nenhuma.`,
      );
    }

    saveRegistryLabel(target, canonical);
    return canonical;
  })().finally(() => {
    creationLocks.delete(key);
  });

  creationLocks.set(key, task);
  return task;
}

async function initializeServiceLabels(channel) {
  if (!env.enableContactLabels || !channel?.client) return false;
  if (initialized) return true;
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    console.log('[ETIQUETAS] verificando etiquetas de serviço uma única vez na inicialização...');
    await wait(1200);

    let allReady = true;
    for (const target of serviceTargets()) {
      const label = await createServiceLabelOnce(channel.client, target);
      if (!label) {
        allReady = false;
        console.warn(`[ETIQUETAS] não foi possível resolver "${target.name}".`);
        continue;
      }
      await syncExistingServiceLabelColor(channel.client, target, label);
      console.log(`[ETIQUETAS] pronta: ${target.name} | ID ${labelId(label)}`);
    }

    initialized = allReady;
    return allReady;
  })().finally(() => {
    initializePromise = null;
  });

  return initializePromise;
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

      const labels = attached.map((item) => {
        const rawId = item?.id || item?.labelId || item;
        const id = rawId ? String(rawId) : '';
        const known = allLabels.find((label) => String(label?.id || label?.labelId || '') === id) || null;
        const name = String(item?.name || item?.label || known?.name || known?.label || '').trim();
        const rawColor = item?.colorIndex ?? item?.colorId ?? item?.color
          ?? known?.colorIndex ?? known?.colorId ?? known?.color;
        return {
          id: id || null,
          name,
          colorIndex: Number.isFinite(Number(rawColor)) ? Number(rawColor) : null,
        };
      }).filter((item) => item.name);

      const unique = [];
      const seen = new Set();
      for (const item of labels) {
        const key = `${item.id || ''}:${normalize(item.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
      }

      return {
        all: unique,
        manual: unique.filter((item) => !managedSet.has(normalize(item.name))),
        managed: unique.filter((item) => managedSet.has(normalize(item.name))),
      };
    }, { chatId, managedNames });

    return {
      all: uniqueLabelMetadata(result?.all || []),
      manual: uniqueLabelMetadata(result?.manual || []),
      managed: uniqueLabelMetadata(result?.managed || []),
    };
  } catch (err) {
    console.warn(`[ETIQUETAS] não foi possível identificar etiquetas atuais de ${chatId}:`, err?.message || err);
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
    session.dados.manualContactLabelsDetectedAt = nowIso();
    Store.saveSession(session);
  } catch (err) {
    console.warn('[ETIQUETAS] não foi possível salvar etiquetas manuais na sessão:', err?.message || err);
  }
}

async function addLabelById(client, chatId, labelIdValue) {
  const id = String(labelIdValue || '').trim();
  if (!id) return false;

  if (typeof client?.addOrRemoveLabels === 'function') {
    await client.addOrRemoveLabels([chatId], [{ labelId: id, type: 'add' }]);
    return true;
  }

  if (client?.page?.evaluate) {
    return client.page.evaluate(async ({ chatId, id }) => {
      const WPP = window.WPP || null;
      if (!WPP?.labels?.addOrRemoveLabels) return false;
      await WPP.labels.addOrRemoveLabels([chatId], [{ labelId: id, type: 'add' }]);
      return true;
    }, { chatId, id });
  }

  return false;
}

async function resolveLabelForUse(client, target) {
  const cached = getCachedLabel(target);
  if (cached?.id) return cached;
  return resolveExistingLabel(client, target, { attempts: 3, delayMs: 400 });
}

async function replaceServiceLabel(channel, clientId, service) {
  if (!env.enableContactLabels || !channel?.client) return false;

  if (!initialized && initializePromise) await initializePromise;
  if (!initialized && !initializePromise) await initializeServiceLabels(channel);

  const client = channel.client;
  const target = getServiceLabel(service);
  if (!target?.name) return false;

  let resolved = await resolveLabelForUse(client, target);
  if (!resolved?.id) {
    console.warn(`[ETIQUETAS] "${target.name}" não foi localizada. Nenhuma nova etiqueta será criada durante o atendimento.`);
    return false;
  }

  const managedNames = managedServiceLabelNames();
  const candidates = Identity.getLabelCandidateIds(clientId);
  if (!candidates.length) candidates.push(Identity.normalizeChatId(clientId));

  for (const chatId of [...new Set(candidates.filter(Boolean))]) {
    const before = await detectAttachedLabels(client, chatId, managedNames);
    if (before.manual.length) persistManualLabels(clientId, before.manual);

    let applied = false;
    try {
      applied = await addLabelById(client, chatId, resolved.id);
    } catch (err) {
      console.warn(`[ETIQUETAS] falha ao aplicar ID ${resolved.id} em ${chatId}:`, err?.message || err);

      // O ID pode ter sido alterado manualmente. Atualiza pelo nome e tenta uma vez,
      // mas nunca cria uma nova etiqueta dentro do atendimento.
      const refreshed = await resolveExistingLabel(client, target, { attempts: 3, delayMs: 500 });
      if (refreshed?.id && refreshed.id !== resolved.id) {
        resolved = saveRegistryLabel(target, refreshed) || refreshed;
        try {
          applied = await addLabelById(client, chatId, resolved.id);
        } catch (retryErr) {
          console.warn(`[ETIQUETAS] segunda tentativa falhou em ${chatId}:`, retryErr?.message || retryErr);
        }
      }
    }

    if (!applied) continue;
    await wait(400);

    const after = await detectAttachedLabels(client, chatId, managedNames);
    const manualLabels = after.manual.length ? after.manual : before.manual;
    persistManualLabels(clientId, manualLabels);

    console.log(`[ETIQUETAS] adicionada por ID sem criar/remover outras: ${target.name} | ${resolved.id} | ${chatId}`);
    return {
      applied: true,
      mode: 'official-label-id',
      chatId,
      targetId: resolved.id,
      targetName: target.name,
      manualLabels,
      managedLabels: after.managed,
    };
  }

  console.warn(`[ETIQUETAS] não foi possível adicionar ${target.name} em nenhum identificador conhecido.`);
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
