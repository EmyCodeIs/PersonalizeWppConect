'use strict';

const customerFlow = require('./flow/customerFlow');
const Store = require('./services/leadStore');
const { handleColorSelectionMessage } = require('./flow/colorSelectionFlow');

if (!customerFlow.__officialColorListPatchInstalled) {
  const originalProcessCustomerMessage = customerFlow.processCustomerMessage;

  if (typeof originalProcessCustomerMessage !== 'function') {
    throw new Error('customerFlow.processCustomerMessage não está disponível para instalar o fluxo de cores.');
  }

  customerFlow.processCustomerMessage = async function processCustomerMessageWithOfficialColors(args = {}) {
    const handled = await handleColorSelectionMessage(args);
    if (handled) return Store.getSession(args.clientId);
    return originalProcessCustomerMessage(args);
  };

  customerFlow.__officialColorListPatchInstalled = true;
  console.log('[COLOR FLOW] listas oficiais instaladas: quantidade -> tipo -> cor -> espessura.');
}
