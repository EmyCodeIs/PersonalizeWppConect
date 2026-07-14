'use strict';

const serviceLabels = require('./core/serviceLabels');
const { ensureRequiredLabelsOnce } = require('./core/requiredLabelsStartup');
const { installIdempotentServiceLabels } = require('./core/idempotentServiceLabels');

serviceLabels.initializeServiceLabels = ensureRequiredLabelsOnce;
installIdempotentServiceLabels();

require('./core/handoffPreload');
require('./core/resetCleanupPreload');
require('./core/customerFlowFixPreload');
require('./bootstrap');
