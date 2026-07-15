'use strict';

const CustomerFlow = require('../flow/customerFlow');
const Store = require('../services/leadStore');
const { normalizeText } = require('./parsers');
const { assignOperationalLabelOnce } = require('./serviceLabelAssignmentPreload');

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function isSupportSelection(value) {
  const text = normalizeText(firstLine(value));
  if (!text) return false;
  if (['serv_suporte', 'suporte', 'preciso de suporte', 'quero suporte', 'falar com suporte'].includes(text)) return true;
  return /(?:falar|conversar) com (?:um )?(?:atendente|vendedor|humano)/.test(text);
}

function installSupportLabelOnSelection() {
  if (CustomerFlow.__supportLabelOnSelectionInstalled) return CustomerFlow;
  const original = CustomerFlow.processCustomerMessage;

  CustomerFlow.processCustomerMessage = async function processWithSupportLabelOnSelection(args = {}) {
    if (isSupportSelection(args.text)) {
      const session = Store.getSession(args.clientId);
      if (session) {
        await assignOperationalLabelOnce(args.channel, args.clientId, session, 'suporte', {
          source: 'support_selection',
        });
      }
    }
    return original(args);
  };

  CustomerFlow.__supportLabelOnSelectionInstalled = true;
  return CustomerFlow;
}

installSupportLabelOnSelection();

module.exports = {
  installSupportLabelOnSelection,
  isSupportSelection,
};
