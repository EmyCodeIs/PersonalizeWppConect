'use strict';

const Mostruario = require('./mostruario');
const { messages } = require('./messages');

function installLetteringIntroAfterCatalog() {
  if (Mostruario.__letteringIntroInstalled) return Mostruario;
  const originalSendMostruario = Mostruario.sendMostruarioLetreiro;
  if (typeof originalSendMostruario !== 'function') return Mostruario;

  Mostruario.sendMostruarioLetreiro = async function sendCatalogThenExplain(channel, clientId) {
    const result = await originalSendMostruario(channel, clientId);
    await channel?.sendText?.(clientId, messages.letteringBudgetIntro);
    console.log(`[FLUXO][LETREIRO] mostruário enviado; coleta de orçamento iniciada | cliente=${clientId} | próximaEtapa=tipo_acrilico`);
    return result;
  };

  Mostruario.__letteringIntroInstalled = true;
  return Mostruario;
}

installLetteringIntroAfterCatalog();

module.exports = { installLetteringIntroAfterCatalog };
