'use strict';

const assert = require('assert');
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

    const channel = {
      async sendCatalog(clientId, payload, options) {
        calls.push({ clientId, payload, options });
        return true;
      },
    };

    const sent = await sendMostruarioCatalog(channel, '5511999999999@c.us');
    assert.strictEqual(sent, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].payload.title, 'Mostruário Letreiros');
    assert.strictEqual(calls[0].payload.description, 'Mostruário Letreiros');
    assert.strictEqual(calls[0].options.noDelay, true);

    process.env.MOSTRUARIO_CATALOG_NAME = 'Catálogo personalizado';
    assert.strictEqual(getCatalogName(), 'Catálogo personalizado');

    console.log('✅ Catálogo nativo do mostruário verificado');
  } finally {
    if (previous === undefined) delete process.env.MOSTRUARIO_CATALOG_NAME;
    else process.env.MOSTRUARIO_CATALOG_NAME = previous;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
