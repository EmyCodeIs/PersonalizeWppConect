'use strict';

const WppClient = require('../services/wppconnectClient');
const { env } = require('../config/env');
const {
  createReconnectTracker,
  createRecoveryRunner,
} = require('./unreadReconnectRecovery');

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function installUnreadReconnectRecovery() {
  if (WppClient.__unreadReconnectRecoveryInstalled) return;

  const originalCreateWppChannel = WppClient.createWppChannel.bind(WppClient);
  WppClient.createWppChannel = async function createWppChannelWithUnreadReconnect(options = {}) {
    const channel = await originalCreateWppChannel(options);
    const enabled = boolEnv('ENABLE_UNREAD_RECONNECT_RECOVERY', true);
    if (!enabled || typeof channel?.client?.onStateChange !== 'function') return channel;

    const recovery = createRecoveryRunner({
      collectUnreadMessages: (client) => WppClient.collectUnreadMessages(client),
      onMessage: options.onMessage,
      getClient: () => channel.client,
      delayMs: env.unreadBootstrapDelayMs,
    });

    const trackState = createReconnectTracker((state) => {
      console.log(`[RECUPERAÇÃO] conexão restaurada (${state}); nova varredura agendada.`);
      recovery.schedule(`reconexao-${state.toLowerCase()}`);
    });

    channel.client.onStateChange(trackState);
    channel.unreadReconnectRecovery = recovery;

    // Versões antigas do .env deixavam ENABLE_UNREAD_BOOTSTRAP=false. Nesse caso,
    // esta varredura inicial recupera o que ficou pendente antes do novo código subir.
    // Quando o bootstrap antigo está ativo, ele continua sendo o único responsável
    // pela varredura inicial, evitando duplicidade desnecessária.
    if (!env.enableUnreadBootstrap) {
      console.log('[RECUPERAÇÃO] bootstrap antigo desativado; varredura inicial segura agendada.');
      recovery.schedule('inicial', env.unreadBootstrapDelayMs);
    }

    return channel;
  };

  WppClient.__unreadReconnectRecoveryInstalled = true;
}

installUnreadReconnectRecovery();

module.exports = {
  boolEnv,
  installUnreadReconnectRecovery,
};
