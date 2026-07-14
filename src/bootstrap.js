'use strict';

require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');
const WppClient = require('./services/wppconnectClient');
const { initializeServiceLabels } = require('./core/serviceLabels');
const { auditStartupLabels, logAuditReport } = require('./core/startupLabelAudit');

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

  const created = await initializeServiceLabels(channel);
  if (!created) {
    console.error('[LISTAS][PRECHECK] não foi possível preparar todas as listas de serviço.');
  }

  let report = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    report = await auditStartupLabels(channel, { requireColor });
    if (report.ready) break;
    console.warn(`[LISTAS][PRECHECK] tentativa ${attempt}/${attempts} ainda não liberou o atendimento.`);
    if (attempt < attempts) await wait(delayMs);
  }

  logAuditReport(report);
  return report;
}

const originalCreateWppChannel = WppClient.createWppChannel;
WppClient.createWppChannel = async function createGuardedWppChannel(options = {}) {
  let ready = false;
  const originalOnMessage = options.onMessage;

  const guardedOnMessage = async (payload) => {
    if (!ready) {
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

  const report = await runLabelPreflight(channel);
  const strict = boolEnv('LABEL_STARTUP_STRICT', true);
  if (!report?.ready && strict) {
    const details = (report?.issues || []).map((item) => item.message).join(' | ');
    throw new Error(`LABEL_STARTUP_BLOCKED${details ? `: ${details}` : ''}`);
  }

  ready = true;
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
