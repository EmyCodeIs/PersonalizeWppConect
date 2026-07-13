'use strict';

const assert = require('assert');
const {
  OutboundMessageTracker,
  outgoingChatId,
} = require('../src/services/outboundMessageTracker');

function testImageUsesRemoteChatAndDoesNotTriggerHandoff() {
  const tracker = new OutboundMessageTracker({ ttlMs: 45000 });
  const customer = '5531971386091@c.us';
  const ownNumber = '5531000000000@c.us';

  tracker.begin({
    chatId: customer,
    kind: 'image',
    texts: ['https://personalizeseuambiente.com.br/bem-vindos'],
  });

  const outgoingImage = {
    fromMe: true,
    from: ownNumber,
    type: 'image',
    caption: 'https://personalizeseuambiente.com.br/bem-vindos',
    id: {
      _serialized: 'true_5531971386091@c.us_IMG001',
      remote: customer,
    },
  };

  assert.strictEqual(outgoingChatId(outgoingImage), customer);
  assert.strictEqual(
    tracker.consume(outgoingImage),
    true,
    'imagem enviada pelo bot precisa ser reconhecida mesmo quando message.from é o número da empresa',
  );

  assert.strictEqual(
    tracker.consume(outgoingImage),
    true,
    'evento duplicado da mesma imagem também precisa continuar reconhecido como bot',
  );
}

function testImageWithoutCaptionSerializedAsText() {
  const tracker = new OutboundMessageTracker({ ttlMs: 45000 });
  const customer = '5531971386091@c.us';

  tracker.begin({ chatId: customer, kind: 'image', texts: [] });

  assert.strictEqual(
    tracker.consume({
      fromMe: true,
      type: 'chat',
      body: '',
      id: { _serialized: 'IMG_EMPTY_1', remote: customer },
    }),
    true,
    'imagem sem legenda serializada como chat vazio não pode virar handoff',
  );
}

function testListSerializedAsChat() {
  const tracker = new OutboundMessageTracker({ ttlMs: 45000 });
  const customer = '5531971386091@c.us';

  tracker.begin({
    chatId: customer,
    kind: 'list',
    texts: ['Qual dos nossos serviços deseja?'],
  });

  assert.strictEqual(
    tracker.consume({
      fromMe: true,
      type: 'chat',
      body: 'Conteúdo interno serializado da lista',
      key: { id: 'LIST001', remoteJid: customer },
    }),
    true,
    'lista automática serializada como chat não pode virar handoff',
  );
}

function testRealManualMessageStillDetected() {
  const tracker = new OutboundMessageTracker({ ttlMs: 45000 });
  const customer = '5531971386091@c.us';

  assert.strictEqual(
    tracker.consume({
      fromMe: true,
      to: customer,
      type: 'chat',
      body: 'Olá, vou continuar seu atendimento por aqui.',
      id: { _serialized: 'SELLER001', remote: customer },
    }),
    false,
    'mensagem manual sem registro programático deve continuar sendo detectada',
  );
}

function run() {
  testImageUsesRemoteChatAndDoesNotTriggerHandoff();
  testImageWithoutCaptionSerializedAsText();
  testListSerializedAsChat();
  testRealManualMessageStillDetected();
  console.log('[TESTE HANDOFF] imagem, lista e eventos duplicados do bot não viram atendimento humano: OK');
}

run();
