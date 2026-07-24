'use strict';

const assert = require('node:assert/strict');
const DecisionLog = require('../src/core/decisionLogger');

assert.deepEqual(DecisionLog.CATEGORIES, [
  'ENTRADA', 'IDENTIDADE', 'RECUPERAÇÃO', 'HANDOFF', 'BUFFER', 'FILA',
  'FLUXO', 'ENVIO', 'ETIQUETA', 'NOTA', 'ADMIN', 'CONEXÃO', 'ERRO',
]);

const first = DecisionLog.shortMessageId({ id: { _serialized: '3EB0ABC123' } });
const second = DecisionLog.shortMessageId({ id: { _serialized: '3EB0ABC123' } });
assert.match(first, /^[A-F0-9]{4}$/);
assert.equal(first, second);

const line = DecisionLog.plainLine('ENTRADA', 'recebida', {
  chat: '5531999999999@c.us',
  msg: first,
  etapa: 'cidade',
  texto: 'Belo Horizonte/MG',
});
assert.match(line, /^ENTRADA · chat=/);
assert.match(line, / · msg=[A-F0-9]{4} · etapa=cidade · evento=recebida · texto=/);
assert.doesNotMatch(line, /5531999999999/);

DecisionLog.run({ chat: '5531999999999@c.us', msg: first, etapa: 'cidade' }, () => {
  const contextual = DecisionLog.plainLine('FLUXO', 'transição', {
    de: 'cidade',
    para: 'envio',
  });
  assert.match(contextual, /^FLUXO · chat=/);
  assert.match(contextual, / · msg=[A-F0-9]{4} · etapa=cidade · evento=/);
  assert.match(contextual, /de=cidade · para=envio$/);
});

assert.match(
  DecisionLog.plainLine('CATEGORIA_INVALIDA', 'teste'),
  /^ERRO · evento=teste$/,
);

console.log('✅ Logs de decisão: categorias, máscara, correlação e contexto validados.');
