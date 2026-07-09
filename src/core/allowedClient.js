'use strict';

const { env } = require('../config/env');

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function lastDigits(value, size = 11) {
  const digits = onlyDigits(value);
  return digits.slice(-size);
}

function collectCandidateValues({ from, raw, resolvedNumber } = {}) {
  const lidMap = env.lidNumberMap || {};
  const fromKey = String(from || '').trim().toLowerCase();
  const mappedNumber = fromKey ? lidMap[fromKey] : null;

  const candidates = [
    from,
    resolvedNumber,
    mappedNumber,
    raw?.resolvedNumber,
    raw?.from,
    raw?.chatId,
    raw?.sender?.id,
    raw?.sender?.id?._serialized,
    raw?.id?.remote,
    raw?.id?._serialized,
    raw?.key?.remoteJid,
    raw?.key?.participant,
    raw?.author,
    raw?.to,
  ];

  // Alguns objetos do WPPConnect/WA-JS trazem o telefone em campos diferentes.
  const sender = raw?.sender || raw?.contact || raw?.chat || {};
  candidates.push(
    sender?.id,
    sender?.id?._serialized,
    sender?.pushname,
    sender?.shortName,
    sender?.formattedName,
    sender?.name,
    sender?.number,
    sender?.phone,
    sender?.userid,
  );

  return candidates
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function isAllowedClient({ from, raw, resolvedNumber } = {}) {
  const allowedNumbers = env.allowedClientNumbers || [];
  const allowedChatIds = env.allowedChatIds || [];

  if (!allowedNumbers.length && !allowedChatIds.length) {
    return { allowed: true, reason: 'sem_whitelist' };
  }

  const candidates = collectCandidateValues({ from, raw, resolvedNumber });
  const normalizedAllowedChatIds = allowedChatIds.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  const normalizedAllowedNumbers = allowedNumbers
    .map((item) => onlyDigits(item))
    .filter(Boolean);

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (normalizedAllowedChatIds.includes(lower)) {
      return { allowed: true, reason: 'chat_id', matched: candidate };
    }

    const candidateDigits = onlyDigits(candidate);
    if (!candidateDigits) continue;

    for (const allowedNumber of normalizedAllowedNumbers) {
      // Aceita 31971386091, 5531971386091 ou qualquer variação que termine com esses dígitos.
      if (
        candidateDigits === allowedNumber ||
        candidateDigits.endsWith(allowedNumber) ||
        allowedNumber.endsWith(candidateDigits) ||
        lastDigits(candidateDigits, 11) === lastDigits(allowedNumber, 11)
      ) {
        return { allowed: true, reason: 'numero', matched: candidate };
      }
    }
  }

  return {
    allowed: false,
    reason: 'fora_da_whitelist',
    candidates: candidates.slice(0, 8),
  };
}

module.exports = { isAllowedClient, collectCandidateValues, onlyDigits };
