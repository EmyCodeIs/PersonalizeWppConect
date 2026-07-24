'use strict';

const Identity = require('../services/contactIdentity');

const buffers = new Set();
const queues = new Set();

function normalizeChatId(value) {
  return Identity.normalizeChatId(value);
}

function candidateChatIds(clientId) {
  const direct = normalizeChatId(clientId);
  let known = [];
  try { known = Identity.getLabelCandidateIds(clientId); } catch (_) {}
  return [...new Set([direct, ...known].map(normalizeChatId).filter(Boolean))];
}

function registerBuffer(buffer) {
  if (buffer) buffers.add(buffer);
  return buffer;
}

function registerQueue(queue) {
  if (queue) queues.add(queue);
  return queue;
}

function cancelContact(clientId, reason = 'human_handoff') {
  const candidates = candidateChatIds(clientId);
  let bufferedMessages = 0;
  let queuedTasks = 0;

  for (const buffer of buffers) {
    for (const chatId of candidates) {
      const item = buffer?.map?.get?.(chatId);
      if (item?.messages?.length) bufferedMessages += item.messages.length;
      try { buffer?.clear?.(chatId); } catch (_) {}
    }
  }

  for (const queue of queues) {
    for (const chatId of candidates) {
      try {
        const result = queue?.cancel?.(chatId, reason);
        queuedTasks += Number(result?.cancelled || 0);
      } catch (_) {}
    }
  }

  console.log(
    `[HANDOFF] automação interrompida | cliente=${clientId} | aliases=${candidates.join(',') || '-'} `
    + `| bufferDescartado=${bufferedMessages} | filaCancelada=${queuedTasks} | motivo=${reason}`,
  );

  return { candidates, bufferedMessages, queuedTasks };
}

module.exports = {
  cancelContact,
  candidateChatIds,
  registerBuffer,
  registerQueue,
  _test: {
    buffers,
    queues,
    normalizeChatId,
  },
};
