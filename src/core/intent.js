'use strict';

const { normalizeText, extractName, extractPhone } = require('./parsers');

const LETTERING_TERMS = [
  'letreiro', 'letra caixa', 'letras caixa', 'acrilico', 'acrílico', 'fachada', 'logo em acrilico', 'placa em acrilico', 'nome em acrilico', 'personalize seu ambiente'
];

const OTHER_SERVICE_TERMS = [
  'papel de parede', 'adesivo', 'adesivacao', 'adesivação', 'banner', 'cartao', 'cartão', 'panfleto', 'impressao', 'impressão', 'plotagem', 'totem', 'placa acm', 'acm', 'fachada acm'
];

const LANDING_TERMS = [
  'landing', 'site', 'orcamento pelo site', 'orçamento pelo site', 'vim pelo site', 'formulario', 'formulário', 'pagina', 'página', 'link da bio', 'instagram'
];

function detectInitialContext(text) {
  const normalized = normalizeText(text);
  const isLanding = LANDING_TERMS.some((term) => normalized.includes(normalizeText(term)));
  const letteringScore = LETTERING_TERMS.reduce((acc, term) => acc + (normalized.includes(normalizeText(term)) ? 1 : 0), 0);
  const otherScore = OTHER_SERVICE_TERMS.reduce((acc, term) => acc + (normalized.includes(normalizeText(term)) ? 1 : 0), 0);

  let flow = 'unknown';
  if (letteringScore > 0 && letteringScore >= otherScore) flow = 'letreiro';
  else if (otherScore > 0) flow = 'outro_servico';

  return {
    flow,
    isLanding,
    name: extractName(text),
    phone: extractPhone(text),
    scores: { letteringScore, otherScore },
    raw: text,
  };
}

module.exports = { detectInitialContext, LETTERING_TERMS, OTHER_SERVICE_TERMS, LANDING_TERMS };
