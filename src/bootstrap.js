'use strict';

const wppconnect = require('@wppconnect-team/wppconnect');
const { patchWppConnect } = require('./services/strictHandoffPolicy');
const { installSellerLabelSendGuard } = require('./services/sellerLabelSendGuard');

patchWppConnect(wppconnect);

const strictCreate = wppconnect.create.bind(wppconnect);
wppconnect.create = async (...args) => {
  const client = await strictCreate(...args);
  return installSellerLabelSendGuard(client);
};

require('./index');
