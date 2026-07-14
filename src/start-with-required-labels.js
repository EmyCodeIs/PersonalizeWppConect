'use strict';

const serviceLabels = require('./core/serviceLabels');
const { ensureRequiredLabelsOnce } = require('./core/requiredLabelsStartup');

serviceLabels.initializeServiceLabels = ensureRequiredLabelsOnce;

require('./bootstrap');
