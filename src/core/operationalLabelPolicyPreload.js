'use strict';

const { env } = require('../config/env');

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureOperationalReplaceGroup() {
  const required = [
    env.serviceLabelLetreiro,
    env.serviceLabelPlotagem,
    env.serviceLabelOutros,
    env.supportLabelName,
  ];
  const configured = Array.isArray(env.serviceLabelReplaceGroup)
    ? env.serviceLabelReplaceGroup
    : [];

  const seen = new Set();
  env.serviceLabelReplaceGroup = [...configured, ...required]
    .map((item) => String(item || '').trim())
    .filter((item) => {
      const key = normalizeName(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return [...env.serviceLabelReplaceGroup];
}

const operationalGroup = ensureOperationalReplaceGroup();
console.log(`[LISTAS] grupo operacional exclusivo: ${operationalGroup.join(' | ')}`);

module.exports = {
  ensureOperationalReplaceGroup,
  normalizeName,
  operationalGroup,
};
