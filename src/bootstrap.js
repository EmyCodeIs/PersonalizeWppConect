'use strict';

require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');
const WppClient = require('./services/wppconnectClient');
const { initializeServiceLabels } = require('./core/serviceLabels');

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

let sessionAccessChild = null;

function startWindowsSessionAccess() {
  if (process.platform !== 'win32') return null;
  if (!boolEnv('SESSION_ACCESS_AUTO_START', true)) {
    console.log('[session-access] inicialização automática desativada no .env');
    return null;
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'session-access-proxy.js');
  sessionAccessChild = spawn(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  sessionAccessChild.on('error', (err) => {
    console.error('[session-access] falha ao iniciar junto com o sistema:', err?.message || err);
  });

  sessionAccessChild.on('exit', (code) => {
    if (code && code !== 0) console.warn(`[session-access] processo encerrou com código ${code}`);
  });

  return sessionAccessChild;
}

function stopWindowsSessionAccess() {
  if (!sessionAccessChild || sessionAccessChild.killed) return;
  try { sessionAccessChild.kill(); } catch (_) {}
}

function configuredServiceLabelNames() {
  const values = [
    process.env.SERVICE_LABEL_LETREIRO,
    process.env.SERVICE_LABEL_PLOTAGEM,
    process.env.SERVICE_LABEL_OUTROS,
    process.env.SERVICE_LABEL_SUPPORT,
    ...String(process.env.SERVICE_LABEL_REPLACE_GROUP || '').split(','),
  ];

  const seen = new Set();
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => {
      const key = normalizeName(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function readLabels(channel) {
  const client = channel?.client;
  if (!client?.page?.evaluate) throw new Error('LABEL_PAGE_UNAVAILABLE');

  return client.page.evaluate(async () => {
    const WPP = window.WPP || null;
    if (!WPP?.labels?.getAllLabels) throw new Error('LABEL_API_UNAVAILABLE');
    const raw = await WPP.labels.getAllLabels();
    const labels = Array.isArray(raw) ? raw : Object.values(raw || {});
    return labels.map((item) => ({
      id: String(item?.id?._serialized || item?.id || item?.labelId || ''),
      name: String(item?.name || item?.label || ''),
      count: Number(item?.count || 0),
    }));
  });
}

function chooseCanonical(labels) {
  return [...labels].sort((a, b) => {
    const byCount = Number(b?.count || 0) - Number(a?.count || 0);
    if (byCount) return byCount;
    const aId = Number(a?.id);
    const bId = Number(b?.id);
    if (Number.isFinite(aId) && Number.isFinite(bId)) return aId - bId;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  })[0] || null;
}

async function deleteLabelById(channel, id) {
  const client = channel?.client;
  if (!client?.page?.evaluate) return { ok: false, reason: 'LABEL_PAGE_UNAVAILABLE' };

  try {
    const result = await client.page.evaluate(async ({ labelId }) => {
      const WPP = window.WPP || null;
      const errorText = (error) => {
        if (typeof error === 'string') return error;
        if (error?.message) return String(error.message);
        if (error?.text) return String(error.text);
        try {
          const serialized = JSON.stringify(error);
          if (serialized && serialized !== '{}') return serialized;
        } catch (_) {}
        return String(error || 'erro desconhecido');
      };

      if (!WPP?.labels?.deleteLabel) {
        return { submitted: false, reason: 'DELETE_LABEL_API_UNAVAILABLE' };
      }

      try {
        const response = await WPP.labels.deleteLabel(String(labelId));
        return { submitted: true, response };
      } catch (error) {
        return { submitted: false, reason: errorText(error) };
      }
    }, { labelId: String(id) });

    await wait(1200);
    const labels = await readLabels(channel);
    const stillExists = labels.some((item) => String(item.id) === String(id));

    return {
      ok: !stillExists,
      submitted: result?.submitted === true,
      reason: stillExists ? (result?.reason || `etiqueta ID=${id} ainda existe após deleteLabel`) : null,
    };
  } catch (error) {
    return { ok: false, reason: error?.stack || error?.message || String(error) };
  }
}

async function repairDuplicateServiceLabelsOnce(channel) {
  const names = configuredServiceLabelNames();
  if (!names.length) {
    console.log('[LISTAS][INÍCIO] nenhuma etiqueta de serviço configurada para conferir.');
    return;
  }

  let labels = await readLabels(channel);

  for (const expectedName of names) {
    const key = normalizeName(expectedName);
    const matches = labels.filter((item) => normalizeName(item.name) === key);
    if (matches.length <= 1) continue;

    const canonical = chooseCanonical(matches);
    const duplicates = matches.filter((item) => String(item.id) !== String(canonical?.id));

    console.warn(
      `[LISTAS][INÍCIO] duplicata encontrada | nome="${expectedName}" | manter=${canonical?.id} `
      + `(${Number(canonical?.count || 0)} conversa(s)) | remover=${duplicates.map((item) => `${item.id}(${Number(item.count || 0)})`).join(',')}`,
    );

    for (const duplicate of duplicates) {
      const result = await deleteLabelById(channel, duplicate.id);
      if (result.ok) {
        console.log(`[LISTAS][INÍCIO] duplicata removida | nome="${expectedName}" | ID=${duplicate.id}`);
      } else {
        console.error(
          `[LISTAS][INÍCIO] falha ao remover duplicata | nome="${expectedName}" | ID=${duplicate.id} `
          + `| motivo=${result.reason || 'desconhecido'}`,
        );
      }
    }

    labels = await readLabels(channel);
  }
}

async function runLabelStartupOnce(channel) {
  if (!boolEnv('LABEL_MAINTENANCE_ENABLED', true)) {
    console.log('[LISTAS][INÍCIO] checagem automática desativada no .env.');
    return;
  }

  console.log('[LISTAS][INÍCIO] conferindo etiquetas uma única vez...');

  try {
    await initializeServiceLabels(channel);
  } catch (error) {
    console.error('[LISTAS][INÍCIO] falha ao criar/localizar etiqueta; atendimento continua:', error?.stack || error?.message || error);
  }

  try {
    await repairDuplicateServiceLabelsOnce(channel);
    const finalLabels = await readLabels(channel);
    const summary = configuredServiceLabelNames().map((name) => {
      const count = finalLabels.filter((item) => normalizeName(item.name) === normalizeName(name)).length;
      return `${name}=${count}`;
    });
    console.log(`[LISTAS][INÍCIO] conferência finalizada | ${summary.join(' | ')}`);
  } catch (error) {
    console.error('[LISTAS][INÍCIO] falha isolada na conferência; atendimento continua:', error?.stack || error?.message || error);
  }
}

async function clearContactForSystemReset(channel, clientId) {
  const chatId = String(clientId || '').trim();
  const result = { noteCleared: false, labelsRemoved: 0, errors: [] };

  try {
    result.noteCleared = await channel.setContactNote(chatId, '') === true;
  } catch (error) {
    result.errors.push(`nota:${error?.message || error}`);
  }

  const client = channel?.client;
  if (!client?.page?.evaluate || !chatId) {
    result.errors.push('etiquetas:LABEL_PAGE_UNAVAILABLE');
    return result;
  }

  try {
    const labelResult = await client.page.evaluate(async ({ chatId }) => {
      const WPP = window.WPP || null;
      const Store = window.Store || null;
      const labelStore = Store?.Label || Store?.Labels || null;
      const getId = (item) => String(item?.id?._serialized || item?.id || item?.labelId || item || '');

      let chat = Store?.Chat?.get?.(chatId) || null;
      if (!chat && typeof Store?.Chat?.find === 'function') chat = await Store.Chat.find(chatId);
      if (!chat) return { removed: 0, error: 'CHAT_NOT_FOUND' };
      if (typeof labelStore?.getLabelsForModel !== 'function') return { removed: 0, error: 'LABEL_STORE_UNAVAILABLE' };

      const beforeRaw = labelStore.getLabelsForModel(chat) || [];
      const before = Array.isArray(beforeRaw) ? beforeRaw : Object.values(beforeRaw || {});
      const ids = [...new Set(before.map(getId).filter(Boolean))];
      if (!ids.length) return { removed: 0, requested: 0 };

      if (typeof WPP?.labels?.addOrRemoveLabels === 'function') {
        await WPP.labels.addOrRemoveLabels(
          [chatId],
          ids.map((id) => ({ labelId: id, type: 'remove' })),
        );
      } else if (typeof WPP?.lists?.removeChats === 'function') {
        for (const id of ids) await WPP.lists.removeChats(id, [chatId]);
      } else {
        return { removed: 0, requested: ids.length, error: 'REMOVE_LABEL_API_UNAVAILABLE' };
      }

      await new Promise((resolve) => setTimeout(resolve, 700));
      const afterRaw = labelStore.getLabelsForModel(chat) || [];
      const after = Array.isArray(afterRaw) ? afterRaw : Object.values(afterRaw || {});
      const remaining = new Set(after.map(getId).filter(Boolean));
      const removed = ids.filter((id) => !remaining.has(id)).length;
      return { removed, requested: ids.length, remaining: remaining.size };
    }, { chatId });

    result.labelsRemoved = Number(labelResult?.removed || 0);
    if (labelResult?.error) result.errors.push(`etiquetas:${labelResult.error}`);
    console.log(
      `[RESETARSYS] limpeza do contato | chat=${chatId} | nota=${result.noteCleared ? 'apagada' : 'não confirmada'} `
      + `| etiquetasRemovidas=${result.labelsRemoved} | erros=${result.errors.join(' | ') || '-'}`,
    );
  } catch (error) {
    result.errors.push(`etiquetas:${error?.message || error}`);
    console.warn(`[RESETARSYS] falha ao limpar contato ${chatId}:`, error?.stack || error?.message || error);
  }

  return result;
}

function installResetCleanup(channel) {
  if (!channel || typeof channel.sendText !== 'function' || channel.__resetCleanupInstalled) return;
  const originalSendText = channel.sendText.bind(channel);

  channel.sendText = async (clientId, text, options = {}) => {
    const message = String(text || '');
    if (message.startsWith('Sistema resetado para teste.')) {
      await clearContactForSystemReset(channel, clientId);
    }
    return originalSendText(clientId, text, options);
  };

  channel.__resetCleanupInstalled = true;
}

const originalCreateWppChannel = WppClient.createWppChannel;
WppClient.createWppChannel = async function createChannelWithStartupLabelCheck(options = {}) {
  const channel = await originalCreateWppChannel(options);
  installResetCleanup(channel);
  await runLabelStartupOnce(channel);
  return channel;
};

startWindowsSessionAccess();
process.once('exit', stopWindowsSessionAccess);
process.once('SIGINT', () => {
  stopWindowsSessionAccess();
  process.exit(130);
});
process.once('SIGTERM', () => {
  stopWindowsSessionAccess();
  process.exit(143);
});

require('./index');