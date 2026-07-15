'use strict';

require('dotenv').config();

const { createWppChannel } = require('../src/services/wppconnectClient');
const { ensureRequiredLabelsOnce } = require('../src/core/requiredLabelsStartup');
const { migrateSellerLabels } = require('../src/core/sellerLabelMigration');

const apply = process.argv.includes('--apply');
const confirmation = process.argv.find((item) => item.startsWith('--confirm='))?.split('=').slice(1).join('=') || '';

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
    await ensureRequiredLabelsOnce(channel);
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

main().catch((error) => {
  console.error('[LISTAS][MIGRAÇÃO] falha:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
