'use strict';

require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');
const WppClient = require('./services/wppconnectClient');
const { initializeServiceLabels } = require('./core/serviceLabels');
const {
  auditStartupLabels,
  logAuditReport,
  repairDuplicateLabels,
} = require('./core/startupLabelAudit');

const PRECHECK_ALLOWED_COMMANDS = new Set(['/reset', '/reiniciar', '/resetarsys']);

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function numEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function extractCommand(payload = {}) {
  const text = String(
    payload?.text
    || payload?.raw?.body
    || payload?.raw?.caption
    || payload?.raw?.text
    || '',
  ).trim();
  return text.split(/\r?\n/)[0].trim().toLowerCase();
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
    if (code && code !== 0) {
      console.warn(`[session-access] processo encerrou com código ${code}`);
    }
  });

  return sessionAccessChild;
}

function stopWindowsSessionAccess() {
  if (!sessionAccessChild || sessionAccessChild.killed) return;
  try { sessionAccessChild.kill(); } catch (_) {}
}

async function runLabelPreflight(channel) {
  const attempts = Math.max(1, numEnv('LABEL_STARTUP_CHECK_ATTEMPTS', 5));
  const delayMs = Math.max(500, numEnv('LABEL_STARTUP_CHECK_DELAY_MS', 1800));
  const requireColor = boolEnv('LABEL_STARTUP_REQUIRE_COLOR', true);
  const autoRemoveDuplicates = boolEnv('LABEL_STARTUP_AUTO_REMOVE_DUPLICATES', true);

  const created = await initializeServiceLabels(channel);
  if (!created) {
    console.error('[LISTAS][PRECHECK] não foi possível preparar todas as listas de serviço.');
  }

  let report = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    report = await auditStartupLabels(channel, { requireColor });

    const hasDuplicates = (report?.issues || []).some((item) => item.code === 'duplicate');
    if (hasDuplicates && autoRemoveDuplicates) {
      const repair = await repairDuplicateLabels(channel, report.snapshot);
      if (repair.deletedIds?.length) {
        console.log(`[LISTAS][REPARO] duplicatas removidas: ${repair.deletedIds.join(', ')}`);
        await wait(1200);
        report = await auditStartupLabels(channel, { requireColor });
      }
    }

    if (report?.ready) break;
    console.warn(`[LISTAS][PRECHECK] tentativa ${attempt}/${attempts} ainda não liberou o atendimento.`);
    if (attempt < attempts) await wait(delayMs);
  }

  logAuditReport(report);
  return report;
}

const originalCreateWppChannel = WppClient.createWppChannel;
WppClient.createWppChannel = async function createGuardedWppChannel(options = {}) {
  const strict = boolEnv('LABEL_STARTUP_STRICT', true);
  const retryMs = Math.max(3000, numEnv('LABEL_STARTUP_RETRY_MS', 15000));
  let ready = !strict;
  let checking = false;
  let retryTimer = null;
  const originalOnMessage = options.onMessage;

  const guardedOnMessage = async (payload) => {
    if (!ready) {
      const command = extractCommand(payload);
      if (PRECHECK_ALLOWED_COMMANDS.has(command)) {
        console.log(`[LISTAS][PRECHECK] comando permitido durante bloqueio: ${command}`);
        return originalOnMessage?.(payload);
      }

      const chatId = payload?.from || payload?.raw?.from || '-';
      console.warn(`[LISTAS][PRECHECK] mensagem ignorada enquanto o sistema valida listas: ${chatId}`);
      await payload?.channel?.markUnread?.(chatId).catch(() => false);
      return;
    }
    return originalOnMessage?.(payload);
  };

  const channel = await originalCreateWppChannel({
    ...options,
    onMessage: guardedOnMessage,
  });

  const scheduleRetry = (delay = retryMs) => {
    if (ready || retryTimer) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      await checkNow();
      if (!ready) scheduleRetry(retryMs);
    }, delay);
    retryTimer.unref?.();
  };

  const checkNow = async () => {
    if (checking) return;
    checking = true;
    try {
      const report = await runLabelPreflight(channel);
      if (report?.ready || !strict) {
        ready = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        console.log('[LISTAS][PRECHECK] atendimento liberado.');
      } else {
        ready = false;
        console.warn(
          `[LISTAS][PRECHECK] atendimento segue bloqueado, mas o sistema permanece ligado. `
          + `Nova tentativa em ${retryMs}ms. /resetarsys continua disponível.`,
        );
      }
    } catch (err) {
      ready = !strict;
      console.error('[LISTAS][PRECHECK] falha inesperada na validação:', err?.message || err);
    } finally {
      checking = false;
    }
  };

  if (strict) {
    console.log('[LISTAS][PRECHECK] atendimento bloqueado até concluir validação e reparo automático.');
  }
  setImmediate(async () => {
    await checkNow();
    if (!ready) scheduleRetry(retryMs);
  });

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
