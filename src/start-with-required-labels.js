'use strict';

require('dotenv').config();

// No Windows, SESSION_ACCESS_AUTO_START decide se o portal local será iniciado.
// Na VPS, `npm run vps:start` cria uma área de trabalho virtual, publica essa
// mesma tela pelo noVNC e inicia o WPPConnect dentro dela.

const duplicateRemovalRequested = ['1', 'true', 'yes', 'sim', 'on']
  .includes(String(process.env.LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES || '').trim().toLowerCase());
const duplicateRemovalConfirmed = String(process.env.LABEL_MAINTENANCE_CONFIRM_DELETE || '').trim()
  === 'CONFIRMAR_EXCLUSAO';

if (duplicateRemovalRequested && !duplicateRemovalConfirmed) {
  process.env.LABEL_MAINTENANCE_AUTO_REMOVE_DUPLICATES = 'false';
  console.warn(
    '[LISTAS][SEGURANÇA] remoção automática solicitada, mas não confirmada; '
    + 'as duplicatas serão somente auditadas.',
  );
}

const serviceLabels = require('./core/serviceLabels');
const { ensureRequiredLabelsOnce } = require('./core/requiredLabelsStartup');
const { installIdempotentServiceLabels } = require('./core/idempotentServiceLabels');
const { installLidServiceLabelFix } = require('./core/lidServiceLabelFix');

serviceLabels.initializeServiceLabels = ensureRequiredLabelsOnce;
installIdempotentServiceLabels();
installLidServiceLabelFix();

require('./core/handoffPreload');
// Precisa carregar entre o monitor de saída e a limpeza do reset: assim o
// /resetarsys digitado pelo vendedor volta ao processador de comandos sem
// ativar handoff, mas ainda preserva os IDs necessários para a limpeza.
require('./core/resetCommandHandoffPreload');
require('./core/resetCleanupPreload');
// Substitui a limpeza ampla antiga por uma limpeza que remove somente as
// etiquetas gerenciadas, preservando as etiquetas manuais do contato.
require('./core/safeResetCleanupOverridePreload');
require('./core/customerFlowFixPreload');
require('./core/preferredSellerNotePreload');
require('./core/completedFlowSilencePreload');
require('./core/runtimeReliabilityPreload');
require('./core/supportAndServicesPreload');
require('./core/exactAcknowledgementPreload');
require('./core/bufferStagePolicyPreload');
require('./core/vpsReadinessPreload');
require('./bootstrap');
