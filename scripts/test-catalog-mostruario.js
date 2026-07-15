'use strict';

const assert = require('assert');
const Mostruario = require('../src/core/mostruario');
const { messages } = require('../src/core/messages');
const {
  DEFAULT_CATALOG_NAME,
  getCatalogName,
  sendMostruarioCatalog,
} = require('../src/core/catalogMostruarioPreload');

async function main() {
  const previous = process.env.MOSTRUARIO_CATALOG_NAME;
  const calls = [];

  try {
    delete process.env.MOSTRUARIO_CATALOG_NAME;
    assert.strictEqual(getCatalogName(), DEFAULT_CATALOG_NAME);
    assert.strictEqual(
      Mostruario.sendMostruarioLetreiro,
      sendMostruarioCatalog,
      'o fluxo precisa usar o catálogo, não a imagem antiga com link',
    );

    const channel = {
      async sendCatalog(clientId, payload, options) {
        calls.push({ type: 'catalog', clientId, payload, options });
        return true;
      },
      async sendText(clientId, text, options) {
        calls.push({ type: 'text', clientId, text, options });
        return true;
      },
      async sendImage() {
        throw new Error('a imagem antiga do mostruário não pode ser enviada');
      },
    };

    const sent = await Mostruario.sendMostruarioLetreiro(channel, '5511999999999@c.us');
    assert.strictEqual(sent, true);
    assert.deepStrictEqual(calls.map((item) => item.type), ['catalog', 'text']);
    assert.strictEqual(calls[0].payload.title, 'Mostruário Letreiros');
    assert.strictEqual(calls[0].payload.description, 'Mostruário Letreiros');
    assert.strictEqual(calls[0].options.noDelay, true);
    assert.strictEqual(calls[1].text, messages.letteringBudgetIntro);
    assert.strictEqual(calls[1].options.noDelay, true);

    const fallbackCalls = [];
    const fallbackChannel = {
      async sendCatalog() { return false; },
      async sendText(clientId, text, options) {
        fallbackCalls.push({ clientId, text, options });
        return true;
      },
      async sendImage() { throw new Error('fallback não pode voltar para a imagem antiga'); },
    };
    await Mostruario.sendMostruarioLetreiro(fallbackChannel, '5511999999999@c.us');
    assert.strictEqual(fallbackCalls.length, 2, 'fallback deve enviar link e depois a explicação');
    assert.strictEqual(fallbackCalls[1].text, messages.letteringBudgetIntro);

    process.env.MOSTRUARIO_CATALOG_NAME = 'Catálogo personalizado';
    assert.strictEqual(getCatalogName(), 'Catálogo personalizado');

    console.log('✅ Catálogo verificado: cartão/link → explicação, sem regressão para imagem antiga.');
  } finally {
    if (previous === undefined) delete process.env.MOSTRUARIO_CATALOG_NAME;
    else process.env.MOSTRUARIO_CATALOG_NAME = previous;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
