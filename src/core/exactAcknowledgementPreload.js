'use strict';

const Store = require('../services/leadStore');
const { normalizeText } = require('./parsers');

function normalizeAck(value) {
  return normalizeText(String(value || ''))
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAcknowledgement(value) {
  const text = normalizeAck(value);
  if (!text) return false;

  const tokens = text.split(' ').filter(Boolean);
  if (!tokens.length || tokens.length > 4) return false;

  const accepted = new Set([
    'ok', 'okk', 'obg', 'obgd', 'obrigado', 'obrigada', 'obrigadao',
    'vlw', 'valeu', 'certo', 'certinho', 'entendi', 'entendido',
    'show', 'beleza', 'blz', 'perfeito', 'isso', 'ta',
    'agradeco', 'gratidao', 'tmj',
  ]);
  const modifiers = new Set(['muito', 'mesmo', 'viu', 'bom']);

  const hasAcknowledgement = tokens.some((token) => accepted.has(token));
  return hasAcknowledgement && tokens.every((token) => accepted.has(token) || modifiers.has(token));
}

const CustomerFlow = require('../flow/customerFlow');
const originalProcessCustomerMessage = CustomerFlow.processCustomerMessage;

CustomerFlow.processCustomerMessage = async function processCustomerMessageWithExactAcknowledgement(args = {}) {
  if (isAcknowledgement(args.text)) {
    const session = Store.getSession(args.clientId);
    await args.channel?.sendText?.(args.clientId, '😁👍');
    console.log(`[FLUXO] agradecimento/confirmação curta reconhecida sem alterar etapa | cliente=${args.clientId}`);
    return session;
  }

  return originalProcessCustomerMessage(args);
};

console.log('[FLUXO] resposta curta alinhada ao sistema antigo: 😁👍');

module.exports = {
  isAcknowledgement,
  normalizeAck,
};
