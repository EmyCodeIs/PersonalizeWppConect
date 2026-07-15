'use strict';

const assert = require('assert/strict');

process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_SUPPORT = 'Suporte';
process.env.SERVICE_LABEL_REPLACE_GROUP = 'Orçamento letreiros,Plotagens,Outros,Suporte';
process.env.SELLER_LABEL_RULES = 'Adriano=#8FD0A8;Ana=#00A4F2;Emy=#7FE51F;C. Eduardo=#FEB100';

const {
  classifyAttachedLabels,
  operationalLabelNames,
} = require('../src/core/exclusiveServiceLabelsPreload');

const current = [
  { id: 'manual-1', name: 'Acompanhar' },
  { id: 'manual-2', name: 'Personalize' },
  { id: 'manual-3', name: 'fornecedor' },
  { id: 'quote-old', name: 'Orçamento letreiros' },
  { id: 'quote-current', name: 'Orçamento letreiros' },
  { id: 'plotagem', name: 'Plotagens' },
  { id: 'support', name: 'Suporte' },
  { id: 'seller', name: 'C. Eduardo' },
];

const result = classifyAttachedLabels(current, 'Orçamento letreiros', 'quote-current');

assert.deepEqual(
  result.remove.map((item) => item.id).sort(),
  ['plotagem', 'quote-old', 'support'],
  'deve remover etiquetas operacionais antigas e duplicata do alvo',
);

assert.deepEqual(
  result.preserve.map((item) => item.id).sort(),
  ['manual-1', 'manual-2', 'manual-3', 'quote-current', 'seller'],
  'deve preservar alvo canônico, etiquetas manuais e vendedor',
);

assert.deepEqual(
  operationalLabelNames().sort(),
  ['orcamento letreiros', 'outros', 'plotagens', 'suporte'],
);

console.log('✅ Etiquetas operacionais exclusivas verificadas; manuais e vendedor preservados.');
