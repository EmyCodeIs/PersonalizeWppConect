'use strict';

const ConversationControl = require('./conversationControl');
const {
  applySellerLabelHandoff,
  inspectSellerLabel,
  normalizeChatId,
} = require('./strictHandoffPolicy');

function installSellerLabelSendGuard(client) {
  if (!client || client.__sellerLabelSendGuardInstalled) return client;

  for (const method of ['sendText', 'sendImage', 'sendFile', 'sendListMessage', 'sendList']) {
    if (typeof client?.[method] !== 'function') continue;
    const original = client[method].bind(client);

    client[method] = async (...args) => {
      const chatId = normalizeChatId(args[0]);
      const status = chatId ? ConversationControl.status(chatId) : null;

      // Respostas de /resetarsys e /reiniciar nunca podem ser bloqueadas.
      if (chatId && !status?.commandBypassActive) {
        const sellerLabel = await inspectSellerLabel(client, chatId);
        if (sellerLabel) {
          applySellerLabelHandoff(chatId, sellerLabel);
          console.log(
            `[HANDOFF] envio automático bloqueado: ${sellerLabel.seller} `
            + `assumiu ${chatId} pela etiqueta ${sellerLabel.color}.`,
          );
          return false;
        }
      }

      return original(...args);
    };
  }

  client.__sellerLabelSendGuardInstalled = true;
  return client;
}

module.exports = { installSellerLabelSendGuard };
