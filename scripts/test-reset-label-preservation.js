'use strict';

const assert = require('assert/strict');

process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_SUPPORT = 'Suporte';
process.env.SELLER_LABEL_RULES = 'Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100';

const {
  managedLabelNames,
  selectManagedLabelIds,
} = require('../src/core/safeResetCleanupOverridePreload');

const labels = [
  { id: '1', name: 'Orçamento letreiros' },
  { id: '2', name: 'Plotagens' },
  { id: '3', name: 'Suporte' },
  { id: '4', name: 'Ana' },
  { id: '5', name: 'C. Eduardo' },
  { id: '6', name: 'Acompanhar' },
  { id: '7', name: 'Fornecedor' },
  { id: '8', name: 'Personalize' },
  { id: '9', name: 'Voltar' },
];

const names = managedLabelNames();
const selected = selectManagedLabelIds(labels, names);

assert.deepEqual(selected.sort(), ['1', '2', '3', '4', '5']);
assert.equal(selected.includes('6'), false, 'Acompanhar deve ser preservada');
assert.equal(selected.includes('7'), false, 'Fornecedor deve ser preservada');
assert.equal(selected.includes('8'), false, 'Personalize deve ser preservada');
assert.equal(selected.includes('9'), false, 'Voltar deve ser preservada');

console.log('✅ Reset/etiquetas verificado: remove somente etiquetas gerenciadas e preserva etiquetas manuais.');
