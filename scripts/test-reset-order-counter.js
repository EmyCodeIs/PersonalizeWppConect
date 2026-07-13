'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SESSION_FILE = path.join('data', 'sessions.reset-order-counter.test.json');
const LEAD_FILE = path.join('data', 'leads.reset-order-counter.test.jsonl');
const IDENTITY_FILE = path.join('data', 'identities.reset-order-counter.test.json');

process.env.SESSIONS_STORE_PATH = SESSION_FILE;
process.env.LEADS_STORE_PATH = LEAD_FILE;
process.env.CONTACT_IDENTITIES_STORE_PATH = IDENTITY_FILE;
process.env.ORDER_NUMBER_START = '70005';

const files = [
  SESSION_FILE,
  `${SESSION_FILE}.tmp`,
  LEAD_FILE,
  IDENTITY_FILE,
  `${IDENTITY_FILE}.tmp`,
];
for (const file of files) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const Store = require('../src/services/leadStore');

try {
  const first = Store.resetSession('5531991111111@c.us');
  assert.strictEqual(Store.ensureOrderNumber(first), 70005);

  const second = Store.resetSession('5531992222222@c.us');
  assert.strictEqual(Store.ensureOrderNumber(second), 70006);

  const reset = Store.resetSystem();
  assert.strictEqual(reset.previousNextOrderNumber, 70007);
  assert.strictEqual(reset.nextOrderNumber, 70005);
  assert.strictEqual(Store.listSessions().length, 0);

  const afterReset = Store.resetSession('5531993333333@c.us');
  assert.strictEqual(
    Store.ensureOrderNumber(afterReset),
    70005,
    'depois do /resetarsys, o primeiro pedido precisa voltar ao número inicial',
  );

  console.log('[TESTE RESET] contador de pedidos voltou para #70005: OK');
} finally {
  for (const file of files) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}
