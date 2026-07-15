'use strict';

const assert = require('assert/strict');

process.env.SELLER_LABEL_RULES = 'Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100';

const {
  buildSellerLabelMigrationPlan,
  normalizeName,
} = require('../src/core/sellerLabelMigration');
const {
  isBusinessDataReady,
  normalizeState,
} = require('./migrate-seller-labels');

const labels = [
  { id: '10', name: 'Adriano', count: 2115 },
  { id: '11', name: 'Adriano', count: 8 },
  { id: '20', name: 'Ana', count: 2933 },
  { id: '21', name: 'Aninha', count: 120 },
  { id: '30', name: 'Emy', count: 1 },
  { id: '40', name: 'C. Eduardo', count: 112 },
  { id: '41', name: 'Carlos', count: 45 },
  { id: '50', name: 'Fornecedor', count: 95 },
  { id: '51', name: 'Acompanhar', count: 12 },
  { id: '52', name: 'Personalize', count: 18 },
  { id: '53', name: 'Voltar', count: 6 },
];

const plan = buildSellerLabelMigrationPlan(labels);

assert.deepEqual(plan.missingTargets, []);
assert.equal(plan.canonical.adriano.id, '10', 'Adriano com mais conversas deve ser o canônico');
assert.equal(plan.canonical.ana.id, '20');
assert.equal(plan.canonical.emy.id, '30');
assert.equal(plan.canonical['c. eduardo'].id, '40');

const bySource = Object.fromEntries(plan.operations.map((operation) => [operation.sourceId, operation]));
assert.equal(bySource['11'].type, 'duplicate');
assert.equal(bySource['11'].targetId, '10');
assert.equal(bySource['21'].type, 'legacy');
assert.equal(bySource['21'].targetId, '20');
assert.equal(bySource['41'].type, 'legacy');
assert.equal(bySource['41'].targetId, '40');

for (const untouched of ['Fornecedor', 'Acompanhar', 'Personalize', 'Voltar']) {
  const item = labels.find((label) => label.name === untouched);
  assert.ok(item);
  assert.equal(bySource[item.id], undefined, `${untouched} não pode entrar na migração`);
}

assert.equal(normalizeName('C. Eduardo'), 'c. eduardo');
assert.equal(normalizeState(' connected '), 'CONNECTED');
assert.equal(isBusinessDataReady({
  state: 'CONNECTED',
  labelsApiReady: true,
  labelCount: 9,
  chatCount: 120,
}), true);
assert.equal(isBusinessDataReady({
  state: 'SYNCING',
  labelsApiReady: true,
  labelCount: 9,
  chatCount: 120,
}), false, 'não pode auditar enquanto o WhatsApp ainda está sincronizando');
assert.equal(isBusinessDataReady({
  state: 'CONNECTED',
  labelsApiReady: true,
  labelCount: 9,
  chatCount: 0,
}), false, 'não pode aceitar leitura vazia de conversas como auditoria real');

console.log('✅ Plano de migração e espera de sincronização verificados sem tocar etiquetas manuais.');