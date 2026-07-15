'use strict';

const assert = require('assert');
const Mostruario = require('../src/core/mostruario');
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
        calls.push({ clientId, payload, options });
        return true;
      },
      async sendImage() {
        throw new Error('a imagem antiga do mostruário não pode ser enviada');
      },
    };

    const sent = await Mostruario.sendMostruarioLetreiro(channel, '5511999999999@c.us');
    assert.strictEqual(sent, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].payload.title, 'Mostruário Letreiros');
    assert.strictEqual(calls[0].payload.description, 'Mostruário Letreiros');
    assert.strictEqual(calls[0].options.noDelay, true);

    const fallbackCalls = [];
    const fallbackChannel = {
      async sendCatalog() { return false; },
      async sendText(clientId, text) { fallbackCalls.push({ clientId, text }); return true; },
      async sendImage() { throw new Error('fallback não pode voltar para a imagem antiga'); },
    };
    await Mostruario.sendMostruarioLetreiro(fallbackChannel, '5511999999999@c.us');
    assert.strictEqual(fallbackCalls.length, 1, 'falha do catálogo deve usar somente link em texto');

    process.env.MOSTRUARIO_CATALOG_NAME = 'Catálogo personalizado';
    assert.strictEqual(getCatalogName(), 'Catálogo personalizado');

    console.log('✅ Catálogo nativo verificado sem regressão para a imagem antiga.');
  } finally {
    if (previous === undefined) delete process.env.MOSTRUARIO_CATALOG_NAME;
    else process.env.MOSTRUARIO_CATALOG_NAME = previous;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
