'use strict';

const Store = require('../services/leadStore');

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function isResetCommand(value) {
  return /^\/(resetarsys|reset|reiniciar)$/i.test(firstLine(value));
}

const CustomerFlow = require('../flow/customerFlow');
const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;

CustomerFlow.processCustomerMessage = async function processCustomerMessageAfterCompletion(args = {}) {
  const session = Store.getSession(args.clientId);
  const completed = Boolean(session?.completed || session?.dados?.botDone || session?.etapa === 'concluido');

  if (completed && !isResetCommand(args.text)) {
    console.log(`[FLUXO] pré-atendimento concluído; mensagem deixada para o vendedor | cliente=${args.clientId}`);
    return session;
  }

  return originalProcessCustomerMessage(args);
};

module.exports = {
  isResetCommand,
};
