'use strict';

const assert = require('node:assert/strict');
const { inspectText } = require('./check-text-integrity');

const validSamples = [
  'RECUPERAÇÃO · conexão restaurada · etapa=cidade',
  'Olá! Você pode enviar a referência do letreiro.',
  '🖼️ Arte recebida → próxima etapa: envio.',
  'Certo, encaminhei sua mensagem para nossa equipe. 🙂',
  '\uFEFFWrite-Host "Instalação concluída"',
];

for (const sample of validSamples) {
  assert.deepEqual(inspectText(sample), [], `texto válido foi recusado: ${sample}`);
}

const invalidSamples = [
  ['FranÃ§a', 'mojibake-utf8'],
  ['AtenÃ§Ã£o', 'mojibake-utf8'],
  ['FLUXO Â· etapa=cidade', 'mojibake-utf8'],
  ['cidade â†’ envio', 'mojibake-utf8'],
  ['emoji ðŸ˜Š', 'mojibake-utf8'],
  ['texto perdido �', 'caractere-substituto'],
  ['texto\u200Binvisível', 'invisivel-perigoso'],
  ['texto\u202Einvertido', 'controle-bidirecional'],
  ['BOM \uFEFF interno', 'bom-interno'],
  ['conexa\u0303o', 'normalizacao'],
];

for (const [sample, expectedId] of invalidSamples) {
  const issues = inspectText(sample);
  assert.equal(
    issues.some((issue) => issue.id === expectedId),
    true,
    `corrupção não detectada (${expectedId}): ${JSON.stringify(sample)}`,
  );
}

console.log('✅ Proteção UTF-8 aceita textos legítimos e rejeita corrupções conhecidas.');
