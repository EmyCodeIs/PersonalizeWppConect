'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));

function run() {
  const packageJson = JSON.parse(read('package.json'));
  assert.strictEqual(packageJson.name, 'personalize-wppconnect-cliente-flow');
  assert.strictEqual(packageJson.version, '0.7.3');

  const requiredProductFiles = [
    'src/flow/customerFlow.js',
    'src/core/messages.js',
    'src/core/menuCatalog.js',
    'src/core/mostruario.js',
    'src/core/parsers.js',
    'src/core/intent.js',
    'src/domain/acrilicoThickness.js',
    'src/services/leadStore.js',
    'src/services/contactIdentity.js',
  ];

  for (const file of requiredProductFiles) {
    assert.strictEqual(exists(file), true, `arquivo obrigatório ausente: ${file}`);
  }

  const flow = require(path.join(root, 'src/flow/customerFlow'));
  const menuCatalog = require(path.join(root, 'src/core/menuCatalog'));
  const { messages } = require(path.join(root, 'src/core/messages'));
  const mostruario = require(path.join(root, 'src/core/mostruario'));

  assert.strictEqual(typeof flow.processCustomerMessage, 'function');
  assert.strictEqual(typeof flow.buildBusinessNote, 'function');
  assert.strictEqual(typeof flow.isGrandeBH, 'function');

  for (const menuName of [
    'servicos',
    'tipoAcrilico',
    'quantidadeCores',
    'espessuraPersonalizada',
    'arte',
    'observacao',
  ]) {
    assert.ok(menuCatalog.menus[menuName], `menu obrigatório ausente: ${menuName}`);
    assert.ok(Array.isArray(menuCatalog.menus[menuName].rows), `menu sem linhas: ${menuName}`);
  }

  assert.deepStrictEqual(
    menuCatalog.menus.servicos.rows.map((row) => row.id),
    ['serv_letreiro', 'serv_plotagem', 'serv_outros'],
  );
  assert.deepStrictEqual(
    menuCatalog.menus.tipoAcrilico.rows.map((row) => row.id),
    ['acr_colorido', 'acr_pintado'],
  );

  for (const messageName of [
    'welcome',
    'askMeasure',
    'askPantone',
    'askArtFree',
    'askCity',
    'askAddress',
    'askObservation',
    'completedContactNote',
  ]) {
    assert.ok(messages[messageName], `mensagem obrigatória ausente: ${messageName}`);
  }

  assert.strictEqual(exists('assets'), true, 'pasta assets ausente no repositório');
  const assetChecks = [
    ['boas-vindas', mostruario.getBemVindosImagePath()],
    ['mostruário', mostruario.getMostruarioImagePath()],
    ['tabela de cores', mostruario.getTabelaCoresPath()],
    ['tabela de espessura', mostruario.getTabelaEspessuraPath()],
    ['tabela de profundidade', mostruario.getTabelaProfundidadePath()],
  ];
  const unresolvedAssets = assetChecks
    .filter(([, asset]) => !asset || !fs.existsSync(asset))
    .map(([name]) => name);

  if (unresolvedAssets.length) {
    console.warn(
      `[CONTRATO PRODUÇÃO] ATENÇÃO: assets não localizados no checkout limpo: ${unresolvedAssets.join(', ')}. `
      + 'A existência desses arquivos na VPS deverá ser confirmada antes da implantação.',
    );
  } else {
    console.log('[CONTRATO PRODUÇÃO] assets configurados localizados: OK');
  }

  const baseline = read('docs/ETAPA_1_LEGADO_PRODUCAO.md');
  assert.match(baseline, /a9daeb1d69a4e043589a97eb63cece8775ab7228/);
  assert.match(baseline, /Problemas conhecidos/);

  console.log('[CONTRATO PRODUÇÃO] arquivos, menus e mensagens: OK');
}

try {
  run();
} catch (error) {
  console.error('[CONTRATO PRODUÇÃO] FALHOU');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
