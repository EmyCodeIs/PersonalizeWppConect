'use strict';

const { BufferManager, mergeMessages } = require('./core/bufferManager');
const { processCustomerMessage } = require('./flow/customerFlow');
const {
  createWppChannel,
  createMockChannel,
  collectUnreadMessages,
} = require('./services/wppconnectClient');
const { installMessageExperience } = require('./core/messageExperience');
const { isAllowedClient } = require('./core/allowedClient');
const { extractName, normalizeText, titleCase } = require('./core/parsers');
const Store = require('./services/leadStore');
const Identity = require('./services/contactIdentity');
const { env } = require('./config/env');

const BUILD_ID = 'production-flow-port-grouped-messages-2026-07-10-02';
const MULTI_MESSAGE_STAGES = new Set([
  'plotagem_descricao',
  'plotagem_medida',
  'plotagem_local',
  'outros_descricao',
  'outros_referencia',
]);

function messageKey(message) {
  const rawId = message?.id?._serialized || message?.id || message?.messageId || message?.key?.id;
  if (rawId) return String(rawId);
  return `${message?.from || message?.chatId || 'unknown'}:${message?.body || message?.text || message?.caption || ''}:${message?.timestamp || ''}`;
}

function sanitizePersonName(value) {
  let name = String(value || '')
    .split(/[\n\r|•]/)[0]
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\+?\d[\d\s().-]{7,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  name = name
    .replace(/^[^A-Za-zÀ-ÿ]+/u, '')
    .replace(/[^A-Za-zÀ-ÿ'’ -]+$/u, '')
    .trim();

  if (!name || name.length < 2 || name.length > 60 || !/[A-Za-zÀ-ÿ]/u.test(name)) return null;
  if (/\d{3,}/.test(name)) return null;
  const generic = normalizeText(name);
  if (['voce', 'você', 'usuario', 'usuário', 'whatsapp', 'desconhecido', 'unknown'].includes(generic)) return null;
  return titleCase(name);
}

function extractProfileName(raw) {
  const candidates = [
    raw?.notifyName,
    raw?.pushname,
    raw?.sender?.pushname,
    raw?.sender?.name,
    raw?.sender?.shortName,
    raw?.sender?.formattedName,
    raw?.contact?.pushname,
    raw?.contact?.name,
    raw?.contact?.shortName,
    raw?.contact?.formattedName,
    raw?.chat?.contact?.pushname,
    raw?.chat?.contact?.name,
    raw?.chat?.contact?.shortName,
    raw?.chat?.contact?.formattedName,
  ];
  for (const candidate of candidates) {
    const name = sanitizePersonName(candidate);
    if (name) return name;
  }
  return null;
}

function extractInteractiveId(raw = {}) {
  const candidates = [
    raw?.selectedRowId,
    raw?.selectedButtonId,
    raw?.listResponse?.singleSelectReply?.selectedRowId,
    raw?.listResponseMessage?.singleSelectReply?.selectedRowId,
    raw?.buttonsResponseMessage?.selectedButtonId,
    raw?.templateButtonReplyMessage?.selectedId,
    raw?.interactive?.list_reply?.id,
    raw?.interactive?.button_reply?.id,
    raw?.nativeFlowResponseMessage?.paramsJson,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (!text) continue;
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          const id = parsed?.id || parsed?.row_id || parsed?.selectedRowId;
          if (id) return String(id).trim();
        } catch (_) {}
      }
      return text;
    }
  }
  return '';
}

function mediaMarker(raw = {}) {
  const type = String(raw?.type || raw?.mimetype || raw?.mediaType || '').toLowerCase();
  const fileName = raw?.filename || raw?.fileName || raw?.document?.filename || '';
  if (/image/.test(type)) return '[imagem enviada]';
  if (/document|pdf|application/.test(type) || fileName) return `[arquivo enviado${fileName ? `: ${fileName}` : ''}]`;
  if (/video/.test(type)) return '[vídeo enviado]';
  return '';
}

function prepareBufferedInput(clientId, text, bufferedMessages) {
  const session = Store.getSession(clientId);
  if (!session) return text;

  const explicitName = sanitizePersonName(extractName(text));
  const profileName = bufferedMessages
    .map((item) => sanitizePersonName(item?.profileName) || extractProfileName(item?.raw))
    .find(Boolean);

  const chosenName = explicitName || (!session.dados?.nome ? profileName : null);
  if (chosenName) {
    session.dados = session.dados || {};
    session.dados.nome = chosenName;
    session.dados.nomeOrigem = explicitName ? 'mensagem' : 'perfil_whatsapp';
    Store.saveSession(session);
    console.log(`[CLIENTE ${clientId}] nome identificado (${session.dados.nomeOrigem}): ${chosenName}`);
  }

  return text;
}

function resolveBufferDelay(clientId, raw, interactiveId) {
  if (interactiveId) return env.interactiveBufferMs;
  const session = Store.getSession(clientId);
  const stage = String(session?.etapa || '').trim();

  // Mesmos tempos operacionais do fluxo Personalize em produção.
  if (stage === 'tamanho') return env.measureBufferMs;
  if (stage === 'arte_coleta') return env.artBufferMs;
  if (stage === 'endereco') return env.addressBufferMs;
  if (stage === 'pantone') return env.pantoneBufferMs;
  if (stage === 'observacao_pedido_coleta') return env.observationBufferMs;
  if (stage === 'cidade') return env.cityBufferMs;
  if (MULTI_MESSAGE_STAGES.has(stage)) return env.multiMessageBufferMs;
  return env.bufferMs;
}

function blockPdfSending(channel) {
  if (!channel) return;
  if (typeof channel.sendDocument === 'function') {
    channel.sendDocument = async () => {
      console.warn('[BLOQUEIO PDF] tentativa de envio de documento bloqueada. O mostruário usa somente link.');
      return false;
    };
  }

  const client = channel.client;
  if (typeof client?.sendFile !== 'function' || client.__personalizePdfGuardInstalled) return;
  const originalSendFile = client.sendFile.bind(client);
  client.sendFile = async (...args) => {
    const serialized = args.map((value) => {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch (_) { return String(value || ''); }
    }).join(' ').toLowerCase();
    if (serialized.includes('.pdf') && serialized.includes('mostruario')) {
      console.warn('[BLOQUEIO PDF] envio do PDF de mostruário bloqueado.');
      return false;
    }
    return originalSendFile(...args);
  };
  client.__personalizePdfGuardInstalled = true;
}

async function main() {
  console.log('[PersonalizeWppConect] iniciando...');
  console.log(`[PersonalizeWppConect] BUILD: ${BUILD_ID}`);
  console.log(`[PersonalizeWppConect] buffer comum: ${env.bufferMs}ms`);
  console.log(`[PersonalizeWppConect] buffers de coleta: medida=${env.measureBufferMs}ms arte=${env.artBufferMs}ms endereço=${env.addressBufferMs}ms Pantone=${env.pantoneBufferMs}ms observação=${env.observationBufferMs}ms cidade=${env.cityBufferMs}ms`);
  console.log(`[PersonalizeWppConect] buffer listas/botões: ${env.interactiveBufferMs}ms`);
  console.log('[PersonalizeWppConect] respostas do mesmo evento: digitação única + balões sem pausa artificial');
  console.log('[PersonalizeWppConect] finalização: dados salvos na nota do contato; sem encaminhamento ao vendedor');

  if (env.allowedClientNumbers?.length || env.allowedChatIds?.length) {
    console.log(`[PersonalizeWppConect] whitelist ativa: números=${env.allowedClientNumbers.join(', ') || '-'} chatIds=${env.allowedChatIds.join(', ') || '-'}`);
  }

  let channel = null;
  const processedMessageIds = new Set();

  const buffer = new BufferManager({
    delayMs: env.bufferMs,
    onFlush: async (clientId, bufferedMessages) => {
      const text = mergeMessages(bufferedMessages);
      if (!text) return;
      const preparedText = prepareBufferedInput(clientId, text, bufferedMessages);
      console.log(`\n[CLIENTE ${clientId}] ${preparedText}\n`);

      const action = () => processCustomerMessage({
        clientId,
        text: preparedText,
        channel,
        messages: bufferedMessages,
      });

      if (typeof channel?.runResponseGroup === 'function') {
        await channel.runResponseGroup(clientId, preparedText, action);
      } else {
        await action();
      }
    },
  });

  const onMessage = async ({ from, text, raw, source = 'event' }) => {
    const interactiveId = extractInteractiveId(raw);
    const effectiveText = interactiveId || String(text || '').trim() || mediaMarker(raw);
    if (!effectiveText) return;

    const profileName = extractProfileName(raw);
    const identity = Identity.registerContact({ chatId: from, raw });
    const canonicalChatId = identity?.primaryChatId || from;

    const allowed = isAllowedClient({ from: canonicalChatId, raw });
    if (!allowed.allowed) {
      console.log(`[PersonalizeWppConect] ignorado (${source}) fora da whitelist: ${canonicalChatId}`);
      return;
    }

    const key = messageKey(raw || { from: canonicalChatId, text: effectiveText });
    if (processedMessageIds.has(key)) return;
    processedMessageIds.add(key);
    if (processedMessageIds.size > 5000) {
      const first = processedMessageIds.values().next().value;
      processedMessageIds.delete(first);
    }

    const delayMs = resolveBufferDelay(canonicalChatId, raw, interactiveId);
    console.log(`[PersonalizeWppConect] mensagem enfileirada (${source}) de ${canonicalChatId}; espera=${delayMs}ms${interactiveId ? `; ação=${interactiveId}` : ''}`);
    buffer.push(canonicalChatId, {
      text: effectiveText,
      raw,
      source,
      identity,
      profileName,
      interactiveId,
    }, { delayMs });
  };

  if (env.mockMode) {
    channel = installMessageExperience(createMockChannel());
    blockPdfSending(channel);
    console.log('[PersonalizeWppConect] MOCK_MODE ativo.');
    return;
  }

  channel = await createWppChannel({ onMessage });
  blockPdfSending(channel);
  installMessageExperience(channel);
  console.log('[PersonalizeWppConect] conectado. Aguardando mensagens...');

  if (env.enableUnreadBootstrap) {
    console.log(`[PersonalizeWppConect] buscando mensagens não lidas em ${env.unreadBootstrapDelayMs}ms...`);
    setTimeout(async () => {
      try {
        const unread = await collectUnreadMessages(channel.client);
        console.log(`[PersonalizeWppConect] mensagens não lidas encontradas: ${unread.length}`);
        for (const item of unread) {
          await onMessage({ from: item.from, text: item.text, raw: item.raw, source: 'unread-bootstrap' });
        }
      } catch (err) {
        console.warn('[PersonalizeWppConect] não foi possível buscar mensagens não lidas:', err?.message || err);
      }
    }, env.unreadBootstrapDelayMs).unref?.();
  }
}

main().catch((err) => {
  console.error('[PersonalizeWppConect] erro fatal:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
