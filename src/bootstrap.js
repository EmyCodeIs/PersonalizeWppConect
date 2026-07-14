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

function numEnv(name, fallback, legacyName = null) {
  const raw = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
  const value = Number(raw);
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

async function runLabelMaintenanceCycle(channel) {
  const attempts = Math.max(1, numEnv(
    'LABEL_MAINTENANCE_CHECK_ATTEMPTS',
    3,
    'LABEL_STARTUP_CHECK_ATTEMPTS',
  ));
  const delayMs = Math.max(500, numEnv(
    'LABEL_MAINTENANCE_CHECK_DELAY_MS',
    1800,
    'LABEL_STARTUP_CHECK_DELAY_MS',
  ));
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

  try {
    const prepared = await initializeServiceLabels(channel);
    if (!prepared) {
      console.warn('[LISTAS][SETOR] nem todas as etiquetas de serviço puderam ser preparadas nesta tentativa.');
    }
  } catch (err) {
    console.warn('[LISTAS][SETOR] preparação falhou sem interromper o atendimento:', err?.message || err);
  }

  let report = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
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
    } catch (err) {
      console.warn('[LISTAS][SETOR] auditoria falhou sem interromper o atendimento:', err?.message || err);
    }

    if (attempt < attempts) await wait(delayMs);
  }

  logAuditReport(report, '[LISTAS][SETOR]');
  return report;
}

function startLabelMaintenanceSupervisor(channel) {
  if (!boolEnv('LABEL_MAINTENANCE_ENABLED', true)) {
    console.log('[LISTAS][SETOR] manutenção automática desativada no .env.');
    return;
  }

  const retryMs = Math.max(5000, numEnv(
    'LABEL_MAINTENANCE_RETRY_MS',
    15000,
    'LABEL_STARTUP_RETRY_MS',
  ));
  let running = false;
  let timer = null;

  const schedule = (delay = retryMs) => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await run();
    }, delay);
    timer.unref?.();
  };

  const run = async () => {
    if (running) {
      schedule(retryMs);
      return;
    }

    running = true;
    try {
      const report = await runLabelMaintenanceCycle(channel);
      if (report?.ready) {
        console.log('[LISTAS][SETOR] etiquetas prontas. Pré-atendimento permaneceu ativo durante a checagem.');
        return;
      }

      console.warn(
        `[LISTAS][SETOR] etiquetas ainda precisam de atenção. `
        + `O pré-atendimento continua ativo; nova tentativa em ${retryMs}ms.`,
      );
      schedule(retryMs);
    } catch (err) {
      console.error(
        '[LISTAS][SETOR] falha isolada na manutenção de etiquetas; o pré-atendimento continua ativo:',
        err?.message || err,
      );
      schedule(retryMs);
    } finally {
      running = false;
    }
  };

  setImmediate(run);
}

const originalCreateWppChannel = WppClient.createWppChannel;
WppClient.createWppChannel = async function createChannelWithIsolatedSectors(options = {}) {
  const channel = await originalCreateWppChannel(options);
  startLabelMaintenanceSupervisor(channel);
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
