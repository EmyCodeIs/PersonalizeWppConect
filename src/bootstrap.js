'use strict';

const wppconnect = require('@wppconnect-team/wppconnect');
const { patchWppConnect } = require('./services/strictHandoffPolicy');

patchWppConnect(wppconnect);
require('./index');
