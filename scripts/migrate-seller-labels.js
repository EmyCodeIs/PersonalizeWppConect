'use strict';

require('dotenv').config();

const { createWppChannel } = require('../src/services/wppconnectClient');
const { ensureRequiredLabelsOnce } = require('../src/core/requiredLabelsStartup');
const { migrateSellerLabels } = require('../src/core/sellerLabelMigration');

const apply = process.argv.includes('--apply');
const confirmation = process.argv.find((item) => item.startsWith('--confirm='))?.split('=').slice(1).join('=') || '';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeState(value) {
  return String(value || '').trim().toUpperCase();
}

function isBusinessDataReady(snapshot = {}) {
  const state = normalizeState(snapshot.state);
  const stateReady = !state || state === 'CONNECTED';
  return stateReady
    && snapshot.labelsApiReady === true
    && Number(snapshot.labelCount || 0) > 0
    && Number(snapshot.chatCount || 0) > 0;
}

async function readBusinessReadiness(client) {
  let state = '';
  try {
    if (typeof client?.getConnectionState === 'function') {
      state = normalizeState(await client.getConnectionState());
    }
  } catch (_) {}

  let page = {
    labelsApiReady: false,
    labelCount: 0,
    chatCount: 0,
    actionApiReady: false,
  };

  if (client?.page?.evaluate) {
    try {
      page = await client.page.evaluate(async () => {
        const WPP = window.WPP || null;
        const Store = window.Store || null;
        let labels = [];

        try {
          if (typeof WPP?.labels?.getAllLabels === 'function') {
            const raw = await WPP.labels.getAllLabels();
            labels = Array.isArray(raw) ? raw : Object.values(raw || {});
          }
        } catch (_) {}

        let chats = [];
        try {
          const rawChats = Store?.Chat?.getModelsArray?.() || Store?.Chat?.models || [];
          chats = Array.isArray(rawChats) ? rawChats : Object.values(rawChats || {});
        } catch (_) {}

        return {
          labelsApiReady: typeof WPP?.labels?.getAllLabels === 'function',
          labelCount: labels.length,
          chatCount: chats.length,
          actionApiReady: typeof WPP?.labels?.addOrRemoveLabels === 'function'
            || typeof WPP?.lists?.addChats === 'function',
        };
      });
    } catch (_) {}
  }

  return { state, ...page };
}

async function waitForBusinessSync(channel, options = {}) {
  const client = channel?.client;
  const timeoutMs = Math.max(30000, Number(options.timeoutMs || 120000));
  const intervalMs = Math.max(1000, Number(options.intervalMs || 2500));
  const startedAt = Date.now();
  let lastLogAt = 0;
  let last = {};

  while ((Date.now() - startedAt) < timeoutMs) {
    last = await readBusinessReadiness(client);
    if (isBusinessDataReady(last)) {
      console.log(
        `[LISTAS][MIGRAÇÃO] WhatsApp sincronizado | estado=${last.state || '-'} `
        + `| etiquetas=${last.labelCount} | conversas=${last.chatCount}`,
      );
      return last;
    }

    if ((Date.now() - lastLogAt) >= 10000) {
      lastLogAt = Date.now();
      console.log(
        `[LISTAS][MIGRAÇÃO] aguardando sincronização | estado=${last.state || '-'} `
        + `| etiquetas=${last.labelCount || 0} | conversas=${last.chatCount || 0}`,
      );
    }

    await wait(intervalMs);
  }

  throw new Error(
    `WhatsApp não terminou a sincronização em ${Math.round(timeoutMs / 1000)}s `
    + `(estado=${last.state || '-'}, etiquetas=${last.labelCount || 0}, conversas=${last.chatCount || 0}). `
    + 'Nenhuma etiqueta foi alterada.',
  );
}

function printReport(report) {
  console.log(`\n[LISTAS][MIGRAÇÃO] modo=${report.apply ? 'APLICAR' : 'AUDITORIA'} | conversasCarregadas=${report.chatCount}`);
  if (report.missingTargets?.length) {
    console.log(`[LISTAS][MIGRAÇÃO] etiquetas corretas ausentes: ${report.missingTargets.join(', ')}`);
  }

  if (!report.operations?.length) {
    console.log('[LISTAS][MIGRAÇÃO] nenhuma etiqueta antiga ou duplicada encontrada.');
    return;
  }

  for (const item of report.operations) {
    if (!report.apply) {
      console.log(
        `[LISTAS][MIGRAÇÃO] ${item.type} | "${item.sourceName}" (ID=${item.sourceId}) `
        + `→ "${item.targetName}" (ID=${item.targetId}) | vínculosEncontrados=${item.attachedChatsFound} `
        + `| contadorWhatsApp=${item.sourceCount}`,
      );
      continue;
    }

    console.log(
      `[LISTAS][MIGRAÇÃO] ${item.type} | "${item.sourceName}" → "${item.targetName}" `
      + `| encontrados=${item.attachedChatsFound} | movidos=${item.moved} | preservadosNaAntiga=${item.retained} `
      + `| falhas=${item.failed} | restantes=${item.remainingChats}/${item.reportedRemaining} `
      + `| etiquetaAntigaExcluída=${item.labelDeleted ? 'sim' : 'não'}`
      + `${item.deletionReason ? ` | motivo=${item.deletionReason}` : ''}`,
    );
  }
}

async function closeWithoutLogout(client) {
  try {
    if (typeof client?.close === 'function') await client.close();
  } catch (error) {
    console.warn('[LISTAS][MIGRAÇÃO] não foi possível fechar o navegador automaticamente:', error?.message || error);
  }
}

async function main() {
  if (String(process.env.MOCK_MODE || '').trim().toLowerCase() === 'true') {
    throw new Error('MIGRAÇÃO_INDISPONÍVEL_EM_MOCK_MODE');
  }

  if (apply && confirmation !== 'MIGRAR_ETIQUETAS_VENDEDORES') {
    throw new Error(
      'Confirmação ausente. Use o script npm labels:sellers:migrate, que inclui a confirmação explícita.',
    );
  }

  console.log('[LISTAS][MIGRAÇÃO] pare o npm start/PM2 antes de executar este comando.');
  console.log('[LISTAS][MIGRAÇÃO] abrindo a sessão existente sem desconectar o WhatsApp...');

  const channel = await createWppChannel();
  try {
    await waitForBusinessSync(channel);

    // Auditoria é somente leitura. A criação das etiquetas corretas ocorre apenas
    // no modo aplicar e somente após o WhatsApp concluir a sincronização.
    if (apply) {
      const requiredReady = await ensureRequiredLabelsOnce(channel);
      if (!requiredReady) {
        throw new Error('Não foi possível confirmar todas as etiquetas corretas. Migração cancelada sem remover vínculos.');
      }
      await wait(2500);
      await waitForBusinessSync(channel, { timeoutMs: 60000 });
    }

    const report = await migrateSellerLabels(channel, { apply });
    printReport(report);

    if (!apply && report.operations?.length) {
      console.log('\n[LISTAS][MIGRAÇÃO] auditoria concluída sem alterações.');
      console.log('[LISTAS][MIGRAÇÃO] para aplicar: npm run labels:sellers:migrate');
    }
  } finally {
    await closeWithoutLogout(channel?.client);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[LISTAS][MIGRAÇÃO] falha:', error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  isBusinessDataReady,
  main,
  normalizeState,
  readBusinessReadiness,
  waitForBusinessSync,
};