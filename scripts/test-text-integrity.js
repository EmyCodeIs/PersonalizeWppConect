'use strict';

const assert = require('node:assert/strict');
const { inspectText } = require('./check-text-integrity');

const chars = (...codePoints) => String.fromCodePoint(...codePoints);

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
  [`Fran${chars(0x00C3, 0x00A7)}a`, 'mojibake-utf8'],
  [`Aten${chars(0x00C3, 0x00A7, 0x00C3, 0x00A3)}o`, 'mojibake-utf8'],
  [`FLUXO ${chars(0x00C2, 0x00B7)} etapa=cidade`, 'mojibake-utf8'],
  [`cidade ${chars(0x00E2, 0x2020, 0x2019)} envio`, 'mojibake-utf8'],
  [`emoji ${chars(0x00F0, 0x0178, 0x02DC, 0x0160)}`, 'mojibake-utf8'],
  [`texto perdido ${chars(0xFFFD)}`, 'caractere-substituto'],
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
