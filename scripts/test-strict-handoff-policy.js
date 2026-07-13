'use strict';

const assert = require('assert');
const {
  RecentBotActivity,
  isHighConfidenceManualMessage,
  matchSellerLabel,
  nearestPaletteIndex,
} = require('../src/services/strictHandoffPolicy');

function testOnlyHumanTextCanTriggerManualHandoff() {
  assert.strictEqual(isHighConfidenceManualMessage({
    fromMe: true,
    type: 'image',
    caption: 'https://personalizeseuambiente.com.br/bem-vindos',
  }), false, 'imagem automática nunca pode assumir atendimento');

  assert.strictEqual(isHighConfidenceManualMessage({
    fromMe: true,
    type: 'chat',
    body: 'https://personalizeseuambiente.com.br/bem-vindos',
  }), false, 'URL isolada da imagem nunca pode assumir atendimento');

  assert.strictEqual(isHighConfidenceManualMessage({
    fromMe: true,
    type: 'list',
    body: 'Serviços',
  }), false, 'lista automática nunca pode assumir atendimento');

  assert.strictEqual(isHighConfidenceManualMessage({
    fromMe: true,
    type: 'chat',
    body: '',
  }), false, 'evento vazio nunca pode assumir atendimento');

  assert.strictEqual(isHighConfidenceManualMessage({
    fromMe: true,
    type: 'chat',
    body: 'Olá, vou continuar seu atendimento por aqui.',
  }), true, 'texto manual real precisa assumir atendimento');
}

function testBotActivityGuard() {
  let current = 1000;
  const activity = new RecentBotActivity({
    guardMs: 8000,
    now: () => current,
  });

  activity.mark('5531999999999@c.us');
  assert.strictEqual(activity.remaining('5531999999999@c.us'), 8000);

  current = 5000;
  assert.strictEqual(activity.remaining('5531999999999@c.us'), 4000);

  current = 9100;
  assert.strictEqual(activity.remaining('5531999999999@c.us'), 0);
}

function testSellerLabelsRequireExactNameAndColor() {
  const palette = [
    '#111111',
    '#00a884',
    '#027eb5',
    '#f7b928',
    '#7f66ff',
  ];

  assert.strictEqual(nearestPaletteIndex(palette, '#00a884'), 1);
  assert.strictEqual(nearestPaletteIndex(palette, '#027eb5'), 2);
  assert.strictEqual(nearestPaletteIndex(palette, '#f7b928'), 3);

  assert.strictEqual(matchSellerLabel([
    { id: 'seller-1', name: 'Adriano', colorIndex: 1 },
  ], palette)?.seller, 'Adriano');

  assert.strictEqual(matchSellerLabel([
    { id: 'seller-2', name: 'Ana', colorIndex: 2 },
  ], palette)?.seller, 'Ana');

  assert.strictEqual(matchSellerLabel([
    { id: 'seller-3', name: 'Dudu', colorIndex: 3 },
  ], palette)?.seller, 'Dudu');

  assert.strictEqual(matchSellerLabel([
    { id: 'wrong-color', name: 'Adriano', colorIndex: 2 },
  ], palette), null, 'nome correto com cor errada não pode assumir atendimento');

  assert.strictEqual(matchSellerLabel([
    { id: 'wrong-name', name: 'Carlos', colorIndex: 1 },
  ], palette), null, 'etiqueta que não pertence aos três vendedores deve ser ignorada');
}

function run() {
  testOnlyHumanTextCanTriggerManualHandoff();
  testBotActivityGuard();
  testSellerLabelsRequireExactNameAndColor();
  console.log('[TESTE HANDOFF ESTRITO] somente texto humano ou etiqueta correta de vendedor assume: OK');
}

run();
