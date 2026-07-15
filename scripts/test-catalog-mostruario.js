'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
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
    assert.equal(getCatalogName(), DEFAULT_CATALOG_NAME);

    const catalogSource = fs.readFileSync(
      path.join(__dirname, '../src/core/catalogMostruarioPreload.js'),
      'utf8',
    );
    assert.equal(catalogSource.includes('letteringBudgetIntro'), false);
    assert.equal(catalogSource.includes("require('./mostruario')"), false);

    const channel = {
      async sendCatalog(clientId, payload) {
        calls.push({ type: 'catalog', clientId, payload });
        return true;
      },
      async sendText(clientId, text) {
        calls.push({ type: 'text', clientId, text });
        return true;
      },
      async sendImage() {
        throw new Error('a imagem antiga do mostruário não pode ser enviada');
      },
    };

    const sent = await sendMostruarioCatalog(channel, '5511999999999@c.us');
    assert.equal(sent, true);
    assert.deepEqual(calls.map((item) => item.type), ['catalog']);
    assert.equal(calls[0].payload.title, 'Mostruário Letreiros');

    const fallbackCalls = [];
    const fallbackChannel = {
      async sendCatalog() { return false; },
      async sendText(clientId, text) {
        fallbackCalls.push({ clientId, text });
        return true;
      },
      async sendImage() {
        throw new Error('fallback não pode voltar para a imagem antiga');
      },
    };
    await sendMostruarioCatalog(fallbackChannel, '5511999999999@c.us');
    assert.equal(fallbackCalls.length, 1, 'falha do catálogo deve usar somente o link');

    process.env.MOSTRUARIO_CATALOG_NAME = 'Catálogo personalizado';
    assert.equal(getCatalogName(), 'Catálogo personalizado');

    console.log('✅ Catálogo novo envia apenas catálogo/link; texto de fluxo fica no customerFlow.');
  } finally {
    if (previous === undefined) delete process.env.MOSTRUARIO_CATALOG_NAME;
    else process.env.MOSTRUARIO_CATALOG_NAME = previous;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
