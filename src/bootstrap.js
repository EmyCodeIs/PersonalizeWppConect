'use strict';

const { installWppConnectModulePatch } = require('./services/wppconnectModulePatch');

installWppConnectModulePatch();
require('./index');
