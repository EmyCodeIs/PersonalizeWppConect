'use strict';

const ServiceLabels = require('./serviceLabels');
const Store = require('../services/leadStore');
const { env } = require('../config/env');

let baseReplaceServiceLabel = null;
let baseApplyNamedLabel = null;

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeService(value) {
  const service = String(value || '').trim().toLowerCase();
  if (['letreiro', 'plotagem', 'outros', 'suporte'].includes(service)) return service;
  return 'outros';
}

function operationalNames() {
  return new Set([
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
    ...(Array.isArray(env.serviceLabelReplaceGroup) ? env.serviceLabelReplaceGroup : []),
  ].map(normalizeName).filter(Boolean));
}

function targetForService(service) {
  const normalized = normalizeService(service);
  if (normalized === 'suporte') {
    return { name: env.supportLabelName, color: env.supportLabelColor };
  }
  return ServiceLabels.getServiceLabel(normalized);
}

function serviceFromTarget(target = {}) {
  const name = normalizeName(target?.name);
  if (name === normalizeName(env.serviceLabelLetreiro)) return 'letreiro';
  if (name === normalizeName(env.serviceLabelPlotagem)) return 'plotagem';
  if (name === normalizeName(env.supportLabelName)) return 'suporte';
  return 'outros';
}

function existingAssignment(session) {
  return session?.dados?.operationalLabelAssignment || null;
}

function resultApplied(result) {
  return result === true || result?.applied === true;
}

function findSession(clientId) {
  return Store.getSession(clientId);
}

async function executeOnce({ channel, clientId, session, service, target, source, execute }) {
  if (!session) return execute();

  const data = session.dados || (session.dados = {});
  const previous = existingAssignment(session);
  const labelName = String(target?.name || '').trim();
  const normalizedService = normalizeService(service);

  if (
    previous?.status === 'applied'
    && previous?.service === normalizedService
    && normalizeName(previous?.labelName) === normalizeName(labelName)
  ) {
    console.log(
      `[ETIQUETAS][SERVIÇO] repetição ignorada | cliente=${clientId} | serviço=${normalizedService} `
      + `| etiqueta="${labelName}" | aplicadaEm=${previous.appliedAt || '-'} | origem=${source}`,
    );
    return {
      applied: true,
      skipped: true,
      changed: false,
      alreadyAttached: true,
      targetName: labelName,
      service: normalizedService,
    };
  }

  const attemptedAt = new Date().toISOString();
  let result = false;
  let errorMessage = null;
  try {
    result = await execute();
  } catch (error) {
    errorMessage = String(error?.message || error);
  }

  const applied = resultApplied(result);
  const alreadyAttached = Boolean(result?.alreadyAttached);
  const changed = applied && !alreadyAttached;
  data.operationalLabelAssignment = {
    service: normalizedService,
    labelName,
    status: applied ? 'applied' : 'failed',
    source,
    attemptedAt,
    appliedAt: applied ? attemptedAt : null,
    changed,
    alreadyAttached,
    verified: result?.verified ?? null,
    chatId: result?.chatId || null,
    error: errorMessage,
  };
  Store.saveSession(session);

  const outcome = applied ? (alreadyAttached ? 'já_presente' : 'aplicada') : 'falhou';
  console.log(
    `[ETIQUETAS][SERVIÇO] cliente=${clientId} | serviço=${normalizedService} | etiqueta="${labelName}" `
    + `| resultado=${outcome} | alterouWhatsApp=${changed ? 'sim' : 'não'} | origem=${source}`,
  );
  if (errorMessage) console.warn(`[ETIQUETAS][SERVIÇO] erro | cliente=${clientId} | ${errorMessage}`);

  return {
    ...(typeof result === 'object' && result ? result : {}),
    applied,
    skipped: false,
    changed,
    alreadyAttached,
    targetName: labelName,
    service: normalizedService,
    error: errorMessage,
  };
}

function installServiceLabelAssignmentOnce() {
  if (ServiceLabels.__serviceLabelAssignmentOnceInstalled) return ServiceLabels;

  baseReplaceServiceLabel = ServiceLabels.replaceServiceLabel.bind(ServiceLabels);
  baseApplyNamedLabel = ServiceLabels.applyNamedLabel.bind(ServiceLabels);

  ServiceLabels.replaceServiceLabel = async function replaceServiceLabelOnce(channel, clientId, service) {
    const normalizedService = normalizeService(service);
    const target = targetForService(normalizedService);
    const session = findSession(clientId);
    return executeOnce({
      channel,
      clientId,
      session,
      service: normalizedService,
      target,
      source: session?.etapa === 'escolher_servico' ? 'service_selection' : 'repeat_guard',
      execute: () => baseReplaceServiceLabel(channel, clientId, normalizedService),
    });
  };

  ServiceLabels.applyNamedLabel = async function applyNamedOperationalLabelOnce(channel, clientId, target) {
    if (!operationalNames().has(normalizeName(target?.name))) {
      return baseApplyNamedLabel(channel, clientId, target);
    }
    const session = findSession(clientId);
    const service = serviceFromTarget(target);
    return executeOnce({
      channel,
      clientId,
      session,
      service,
      target,
      source: service === 'suporte' && session?.etapa === 'suporte_coleta'
        ? 'support_selection'
        : 'repeat_guard',
      execute: () => baseApplyNamedLabel(channel, clientId, target),
    });
  };

  ServiceLabels.__serviceLabelAssignmentOnceInstalled = true;
  return ServiceLabels;
}

async function assignOperationalLabelOnce(channel, clientId, session, service, options = {}) {
  const normalizedService = normalizeService(service);
  const target = options.target || targetForService(normalizedService);
  return executeOnce({
    channel,
    clientId,
    session,
    service: normalizedService,
    target,
    source: String(options.source || 'service_selection'),
    execute: () => baseApplyNamedLabel(channel, clientId, target),
  });
}

installServiceLabelAssignmentOnce();

module.exports = {
  assignOperationalLabelOnce,
  existingAssignment,
  installServiceLabelAssignmentOnce,
  normalizeName,
  normalizeService,
  operationalNames,
  serviceFromTarget,
  targetForService,
};
