'use strict';

const { installStrictHandoffPolicy } = require('./strictHandoffPolicy');
const { installSellerLabelSendGuard } = require('./sellerLabelSendGuard');

function createPatchedWppConnect(originalWppConnect) {
  if (!originalWppConnect || typeof originalWppConnect.create !== 'function') {
    return originalWppConnect;
  }

  const originalCreate = originalWppConnect.create.bind(originalWppConnect);
  const patched = Object.create(originalWppConnect);

  Object.defineProperty(patched, 'create', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: async (...args) => {
      const client = await originalCreate(...args);
      installStrictHandoffPolicy(client);
      installSellerLabelSendGuard(client);
      return client;
    },
  });

  Object.defineProperty(patched, '__personalizeStrictHandoffPatched', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  return patched;
}

function installWppConnectModulePatch() {
  const modulePath = require.resolve('@wppconnect-team/wppconnect');
  const originalWppConnect = require(modulePath);
  const patched = createPatchedWppConnect(originalWppConnect);

  if (require.cache[modulePath]) {
    require.cache[modulePath].exports = patched;
  }

  return patched;
}

module.exports = {
  createPatchedWppConnect,
  installWppConnectModulePatch,
};
