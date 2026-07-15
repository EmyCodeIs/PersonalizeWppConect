'use strict';

const Mostruario = require('./mostruario');
const MenuCatalog = require('./menuCatalog');
const { messages } = require('./messages');

const pendingIntro = new Set();

function normalizeClientId(value) {
  return String(value || '').trim();
}

function isAcrylicMenu(menuKeyOrDefinition) {
  if (typeof menuKeyOrDefinition === 'string') return menuKeyOrDefinition === 'tipoAcrilico';
  return String(menuKeyOrDefinition?.title || '').trim() === 'Selecione o tipo de acrílico do seu letreiro:';
}

function installLetteringIntroAfterCatalog() {
  if (Mostruario.__letteringIntroInstalled) return { Mostruario, MenuCatalog };

  const originalSendMostruario = Mostruario.sendMostruarioLetreiro;
  const originalSendMenu = MenuCatalog.sendMenu;
  if (typeof originalSendMostruario !== 'function' || typeof originalSendMenu !== 'function') {
    return { Mostruario, MenuCatalog };
  }

  Mostruario.sendMostruarioLetreiro = async function markIntroAfterCatalog(channel, clientId) {
    const result = await originalSendMostruario(channel, clientId);
    pendingIntro.add(normalizeClientId(clientId));
    return result;
  };

  MenuCatalog.sendMenu = async function sendIntroBeforeAcrylicMenu(
    channel,
    clientId,
    menuKeyOrDefinition,
    options = {},
  ) {
    const key = normalizeClientId(clientId);
    if (pendingIntro.has(key) && isAcrylicMenu(menuKeyOrDefinition)) {
      pendingIntro.delete(key);
      await channel?.sendText?.(clientId, messages.letteringBudgetIntro);
      console.log(
        `[FLUXO][LETREIRO] explicação enviada após o catálogo | cliente=${clientId} `
        + '| próximaEtapa=tipo_acrilico',
      );
    }
    return originalSendMenu(channel, clientId, menuKeyOrDefinition, options);
  };

  Mostruario.__letteringIntroInstalled = true;
  MenuCatalog.__letteringIntroInstalled = true;

  // Congela no fluxo real as referências já corrigidas. Isso evita que o fluxo
  // capture as funções antigas por desestruturação em outra ordem de preload.
  require('../flow/customerFlow');
  return { Mostruario, MenuCatalog };
}

installLetteringIntroAfterCatalog();

module.exports = {
  installLetteringIntroAfterCatalog,
  isAcrylicMenu,
  normalizeClientId,
  pendingIntro,
};
