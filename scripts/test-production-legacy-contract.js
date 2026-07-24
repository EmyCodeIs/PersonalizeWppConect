'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const PRODUCTION_COMMIT = 'b1ef42daddba021a4eda7269c514a1958ba62f9d';

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath));
}

function readText(relativePath) {
  return read(relativePath).toString('utf8');
}

function gitBlobSha(relativePath) {
  const content = read(relativePath);
  const header = Buffer.from(`blob ${content.length}\0`);
  return crypto.createHash('sha1').update(header).update(content).digest('hex');
}

function assertOrdered(text, markers, source) {
  let previous = -1;
  for (const marker of markers) {
    const current = text.indexOf(marker, previous + 1);
    assert.notEqual(current, -1, `${source}: marcador ausente ou fora de ordem: ${marker}`);
    previous = current;
  }
}

const pkg = JSON.parse(readText('package.json'));
assert.equal(pkg.version, '0.7.3', 'a versão de produção protegida deve continuar declarada como 0.7.3');
assert.equal(pkg.main, 'src/start-with-required-labels.js', 'a entrada real precisa carregar os preloads de produção');
assert.equal(pkg.scripts.start, 'node src/start-with-required-labels.js');
assert.equal(pkg.scripts.dev, 'node src/start-with-required-labels.js');
assert.match(String(pkg.engines?.node || ''), /22/, 'a validação deve respeitar o Node 22 usado pelo projeto');

const startup = readText('src/start-with-required-labels.js');
assertOrdered(startup, [
  "require('./core/safeLoggingPreload')",
  "require('./core/operationalLabelPolicyPreload')",
  "require('./core/exclusiveServiceLabelsPreload')",
  "require('./core/serviceLabelAssignmentPreload')",
  "require('./core/catalogMostruarioPreload')",
  "require('./core/handoffPreload')",
  "require('./core/resetCommandHandoffPreload')",
  "require('./core/testCommandAccessPreload')",
  "require('./core/resetCleanupPreload')",
  "require('./core/safeResetCleanupOverridePreload')",
  "require('./core/customerFlowFixPreload')",
  "require('./core/preferredSellerNotePreload')",
  "require('./core/completedFlowSilencePreload')",
  "require('./core/runtimeReliabilityPreload')",
  "require('./core/unreadReconnectRecoveryPreload')",
  "require('./core/supportAndServicesPreload')",
  "require('./core/supportLabelSelectionPreload')",
  "require('./core/exactAcknowledgementPreload')",
  "require('./core/bufferStagePolicyPreload')",
  "require('./core/vpsReadinessPreload')",
  "require('./core/sellerAliasHandoffPreload')",
  "require('./core/sellerLabelEventsPreload')",
  "require('./bootstrap')",
], 'src/start-with-required-labels.js');

const bootstrap = readText('src/bootstrap.js');
const wrapperStart = bootstrap.indexOf('WppClient.createWppChannel = async function createChannelWithStartupLabelCheck');
assert.notEqual(wrapperStart, -1, 'src/bootstrap.js: wrapper da conexão ausente');
assertOrdered(bootstrap.slice(wrapperStart), [
  'WppClient.createWppChannel = async function createChannelWithStartupLabelCheck',
  'installResetCleanup(channel)',
  'await runLabelStartupOnce(channel)',
  "require('./index')",
], 'src/bootstrap.js: wrapper em execução');

const requiredStructure = [
  'src/index.js',
  'src/core/bufferManager.js',
  'src/core/chatTaskQueue.js',
  'src/core/sellerHandoff.js',
  'src/flow/customerFlow.js',
  'src/services/contactIdentity.js',
  'src/services/leadStore.js',
  'src/services/wppconnectClient.js',
];
for (const relativePath of requiredStructure) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `estrutura de produção ausente: ${relativePath}`);
}

// Estes arquivos representam mensagens, menus, sequência e regras comerciais.
// Mudanças intencionais precisam atualizar conscientemente este contrato.
const protectedCommercialBlobs = {
  'src/flow/customerFlow.js': 'd55106cd7f61f15bf85ba9f9d2af97daadffd191',
  'src/core/messages.js': 'dafaebba54741bb49250531db1d3f273f3d7b9bc',
  'src/core/menuCatalog.js': '91e62bfea2a98af1428189ba0f2238fbee613889',
  'src/core/mostruario.js': '3e2e96fd8d8ea8079ac9825918ecfea7b2ced26d',
  'src/core/intent.js': 'bd6374334b6286383f0540605aa395196e61effe',
  'src/core/parsers.js': '44f7afb2da4b7c2a5d6772ac629960e051204ecb',
  'src/domain/acrilicoThickness.js': 'a26d1706fe867b4ad1035cff2aebe839be6ac71e',
};
for (const [relativePath, expectedSha] of Object.entries(protectedCommercialBlobs)) {
  assert.equal(gitBlobSha(relativePath), expectedSha, `contrato comercial alterado: ${relativePath}`);
}

console.log(`✅ Contrato do legado validado sobre a produção ${PRODUCTION_COMMIT.slice(0, 7)}.`);
console.log(`✅ ${Object.keys(protectedCommercialBlobs).length} arquivos comerciais protegidos contra alteração incidental.`);
console.log('✅ Entrada, ordem dos preloads, bootstrap, buffer, fila, estado e conexão estão mapeados.');
