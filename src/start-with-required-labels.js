'use strict';

require('dotenv').config();

// No Windows, SESSION_ACCESS_AUTO_START decide se o portal local será iniciado.
// Na VPS, `npm run vps:start` cria uma área de trabalho virtual, publica essa
// mesma tela pelo noVNC e inicia o WPPConnect dentro dela.

const INSTAGRAM_WELCOME_URL = 'https://www.instagram.com/personalizeseuambiente?igsh=NW9wYzI5ZHc1MnF2';
const LEGACY_WELCOME_URL = 'https://personalizeseuambiente.com.br/bem-vindos';
const configuredWelcomeUrl = String(process.env.BEM_VINDOS_LINK_URL || '').trim();

// Migra automaticamente o valor antigo. Um link diferente definido futuramente
// no .env continua sendo respeitado.
if (!configuredWelcomeUrl || configuredWelcomeUrl === LEGACY_WELCOME_URL) {
  process.env.BEM_VINDOS_LINK_URL = INSTAGRAM_WELCOME_URL;
}

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

// Mantém somente uma etiqueta operacional entre Letreiros, Plotagens, Outros
// e Suporte. Etiquetas manuais e a etiqueta exata do vendedor são preservadas.
require('./core/exclusiveServiceLabelsPreload');

// Precisa carregar antes do fluxo para trocar o mostruário antigo pelo cartão
// nativo do catálogo do WhatsApp Business.
require('./core/catalogMostruarioPreload');
require('./core/handoffPreload');
// Precisa carregar antes da proteção administrativa: comandos digitados pelo
// próprio WhatsApp Business voltam ao processador sem ativar handoff.
require('./core/resetCommandHandoffPreload');
// Mantém os comandos ativos somente para os números/IDs administrativos
// configurados separadamente da whitelist geral de atendimento.
require('./core/testCommandAccessPreload');
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
