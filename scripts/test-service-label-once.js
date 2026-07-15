'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-label-once-'));
process.chdir(tempDir);
process.env.MOCK_MODE = 'true';
process.env.SERVICE_LABEL_LETREIRO = 'Orçamento letreiros';
process.env.SERVICE_LABEL_PLOTAGEM = 'Plotagens';
process.env.SERVICE_LABEL_OUTROS = 'Outros';
process.env.SERVICE_LABEL_SUPPORT = 'Suporte';

async function main() {
  const ServiceLabels = require('../src/core/serviceLabels');
  const Store = require('../src/services/leadStore');

  const originalApplyNamedLabel = ServiceLabels.applyNamedLabel;
  const originalReplaceServiceLabel = ServiceLabels.replaceServiceLabel;
  const calls = [];

  ServiceLabels.applyNamedLabel = async (_channel, clientId, target) => {
    calls.push({ method: 'apply', clientId, target });
    return { applied: true, alreadyAttached: false, verified: true, chatId: clientId };
  };
  ServiceLabels.replaceServiceLabel = async (_channel, clientId, service) => {
    calls.push({ method: 'replace', clientId, service });
    return { applied: true, alreadyAttached: false, verified: true, chatId: clientId };
  };

  const Assignment = require('../src/core/serviceLabelAssignmentPreload');

  try {
    const clientId = '5531999999911@c.us';
    const session = Store.getSession(clientId);
    session.dados = {};
    session.etapa = 'escolher_servico';
    Store.saveSession(session);

    const first = await ServiceLabels.replaceServiceLabel({}, clientId, 'letreiro');
    session.etapa = 'concluido';
    Store.saveSession(session);
    const repeatedAtFinish = await ServiceLabels.replaceServiceLabel({}, clientId, 'letreiro');

    assert.equal(first.applied, true);
    assert.equal(first.skipped, false);
    assert.equal(repeatedAtFinish.applied, true);
    assert.equal(repeatedAtFinish.skipped, true);
    assert.equal(calls.length, 1, 'a finalização não pode chamar o WhatsApp novamente');
    assert.equal(session.dados.operationalLabelAssignment.service, 'letreiro');
    assert.equal(session.dados.operationalLabelAssignment.status, 'applied');

    await Assignment.assignOperationalLabelOnce({}, clientId, session, 'plotagem', {
      source: 'new_service_after_reset',
    });
    assert.equal(calls.length, 2, 'um serviço diferente pode substituir a etiqueta operacional');

    const startSource = fs.readFileSync(path.join(originalCwd, 'src/start-with-required-labels.js'), 'utf8');
    assert.equal(startSource.includes("require('./core/serviceLabelAssignmentPreload')"), true);
    assert.equal(startSource.includes("require('./core/supportLabelSelectionPreload')"), true);

    console.log('✅ Etiqueta operacional aplicada uma única vez na escolha do serviço.');
  } finally {
    ServiceLabels.applyNamedLabel = originalApplyNamedLabel;
    ServiceLabels.replaceServiceLabel = originalReplaceServiceLabel;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
