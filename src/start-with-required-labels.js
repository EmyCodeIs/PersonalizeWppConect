'use strict';

// O compartilhamento de tela não é iniciado no Windows.
// Na VPS, `npm run vps:start` cria uma área de trabalho virtual,
// publica essa mesma tela pelo noVNC e inicia o WPPConnect nela.
if (process.platform === 'win32') {
  process.env.SESSION_ACCESS_AUTO_START = 'false';
}

const serviceLabels = require('./core/serviceLabels');
const { ensureRequiredLabelsOnce } = require('./core/requiredLabelsStartup');
const { installIdempotentServiceLabels } = require('./core/idempotentServiceLabels');
const { installLidServiceLabelFix } = require('./core/lidServiceLabelFix');

serviceLabels.initializeServiceLabels = ensureRequiredLabelsOnce;
installIdempotentServiceLabels();
installLidServiceLabelFix();

require('./core/handoffPreload');
require('./core/resetCleanupPreload');
require('./core/customerFlowFixPreload');
require('./core/preferredSellerNotePreload');
require('./core/completedFlowSilencePreload');
require('./core/runtimeReliabilityPreload');
require('./core/supportAndServicesPreload');
require('./core/exactAcknowledgementPreload');
require('./core/bufferStagePolicyPreload');
require('./bootstrap');
