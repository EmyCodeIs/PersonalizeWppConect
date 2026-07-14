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

function boolEnv(name, fallback = false, legacyName = null) {
  const raw = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
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

async function runLabelStartupOnce(channel) {
  if (!boolEnv('LABEL_MAINTENANCE_ENABLED', true)) {
    console.log('[LISTAS][INÍCIO] checagem automática desativada no .env.');
    return;
  }

  const requireColor = boolEnv(
    'LABEL_MAINTENANCE_REQUIRE_COLOR',
    true,
    'LABEL_STARTUP_REQUIRE_COLOR',
  );
  const autoRemoveDuplicates = boolEnv(
    'LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES',
    true,
    'LABEL_STARTUP_AUTO_REMOVE_DUPLICATES',
  );

  console.log('[LISTAS][INÍCIO] conferindo etiquetas existentes uma única vez...');

  try {
    const prepared = await initializeServiceLabels(channel);
    if (!prepared) {
      console.warn('[LISTAS][INÍCIO] alguma etiqueta de serviço não pôde ser criada ou localizada. O atendimento continuará.');
    }
  } catch (error) {
    console.error('[LISTAS][INÍCIO] falha ao criar/localizar etiquetas; atendimento preservado:', error?.stack || error?.message || error);
  }

  try {
    let report = await auditStartupLabels(channel, { requireColor });
    const hasDuplicates = (report?.issues || []).some(
      (item) => item.code === 'duplicate' && item.target?.type === 'serviço',
    );

    if (hasDuplicates && autoRemoveDuplicates) {
      const repair = await repairDuplicateLabels(channel, report.snapshot);
      if (repair.deletedIds?.length) {
        console.log(`[LISTAS][INÍCIO] duplicatas removidas e confirmadas: ${repair.deletedIds.join(', ')}`);
      }
      if (repair.failures?.length) {
        console.warn(`[LISTAS][INÍCIO] duplicatas que permaneceram: ${JSON.stringify(repair.failures)}`);
      }
      await wait(900);
      report = await auditStartupLabels(channel, { requireColor });
    }

    logAuditReport(report, '[LISTAS][INÍCIO]');
  } catch (error) {
    console.error('[LISTAS][INÍCIO] falha isolada na conferência; atendimento preservado:', error?.stack || error?.message || error);
  }
}

const originalCreateWppChannel = WppClient.createWppChannel;
WppClient.createWppChannel = async function createChannelWithStartupLabelCheck(options = {}) {
  const channel = await originalCreateWppChannel(options);
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
