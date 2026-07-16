'use strict';

const WppClient = require('../services/wppconnectClient');
const { env } = require('../config/env');
const {
  createReconnectTracker,
  createRecoveryRunner,
} = require('./unreadReconnectRecovery');

function installUnreadReconnectRecovery() {
  if (WppClient.__unreadReconnectRecoveryInstalled) return;

  const originalCreateWppChannel = WppClient.createWppChannel.bind(WppClient);
  WppClient.createWppChannel = async function createWppChannelWithUnreadReconnect(options = {}) {
    const channel = await originalCreateWppChannel(options);
    if (!env.enableUnreadBootstrap || typeof channel?.client?.onStateChange !== 'function') return channel;

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
    return channel;
  };

  WppClient.__unreadReconnectRecoveryInstalled = true;
}

installUnreadReconnectRecovery();

module.exports = {
  installUnreadReconnectRecovery,
};
