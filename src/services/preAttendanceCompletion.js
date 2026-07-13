'use strict';

const Store = require('./leadStore');
const { env } = require('../config/env');
const { markContactUnread } = require('../core/serviceLabels');

function nowIso() {
  return new Date().toISOString();
}

function normalizeOrigin(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('landing')) return 'LandingPage';
  if (text.includes('whatsapp')) return 'WhatsApp';
  return String(value || '').trim() || null;
}

function phoneForNote(session) {
  const explicit = String(session?.dados?.telefone || '').replace(/\D/g, '');
  if (explicit) return explicit;
  const identityPhone = String(session?.contactIdentity?.phone || '').replace(/\D/g, '');
  if (identityPhone) return identityPhone;
  const cUsId = String(session?.contactIdentity?.cUsId || session?.chatId || '');
  return /@c\.us$/i.test(cUsId) ? cUsId.replace(/\D/g, '') : null;
}

function extractDemand(value) {
  const raw = String(value || '').trim();
  const hasReference = /\[(?:imagem|arquivo|documento|vídeo|video)\s+enviad[oa]/i.test(raw);
  const description = raw
    .replace(/\[(?:imagem|arquivo|documento|vídeo|video)\s+enviad[oa](?::[^\]]+)?\]/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { description, hasReference };
}

function buildPreAttendanceNote(session, service) {
  const data = session?.dados || {};
  const demand = data.demanda || {};
  const orderNumber = Number(data.pedidoNumero);
  const phone = phoneForNote(session);
  const title = service === 'plotagem' ? '*Plotagem*' : '*Outros serviços*';
  const label = service === 'plotagem' ? '• Demanda' : '• Solicitação';
  const lines = [
    `📋 *Dados do pedido*${Number.isInteger(orderNumber) && orderNumber > 0 ? ` (#${orderNumber})` : ''}`,
  ];

  if (data.nome) lines.push(`👤 Cliente: ${data.nome}`);
  if (phone) lines.push(`📱 Telefone: ${phone}`);
  if (data.origem) lines.push(`🌐 Origem: ${normalizeOrigin(data.origem)}`);

  lines.push('', title);
  if (demand.descricao) lines.push(`${label}: ${demand.descricao}`);
  if (demand.referenciaNaConversa) lines.push('Arquivo de referência na conversa');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function completePreAttendance({ channel, clientId, service } = {}) {
  const normalizedService = service === 'plotagem' ? 'plotagem' : 'outros';
  const session = Store.getSession(clientId);
  if (!session) return null;
  if (session.completed || session.dados?.botDone) return session;

  session.dados = session.dados || {};
  session.dados.demanda = session.dados.demanda || {};
  const parsed = extractDemand(session.dados.demanda.descricao);
  session.dados.demanda.descricao = parsed.description || null;
  session.dados.demanda.referenciaNaConversa = Boolean(parsed.hasReference);

  const orderNumber = Store.ensureOrderNumber(session);
  const completedAt = nowIso();
  const silenceHours = Math.max(1, Number(env.botReentryAfterHours || 72));

  session.dados.pedidoNumero = orderNumber;
  session.dados.preAtendimento = true;
  session.dados.completedAt = completedAt;
  session.dados.botDone = true;
  session.dados.botControl = {
    state: 'silent',
    reason: `pre_atendimento_${normalizedService}`,
    startedAt: completedAt,
    silenceUntil: new Date(Date.parse(completedAt) + (silenceHours * 60 * 60 * 1000)).toISOString(),
    lastClientMessageAt: completedAt,
    lastSellerMessageAt: null,
    updatedAt: completedAt,
  };
  session.etapa = 'concluido';
  session.completed = true;
  Store.saveSession(session);

  Store.appendLead({
    event: 'pre_attendance_completed',
    clientId: session.id,
    orderNumber,
    service: normalizedService,
    reason: `${normalizedService}_demanda_recebida`,
    etapa: session.etapa,
    dados: session.dados,
  });

  if (env.enableContactNotes && typeof channel?.setContactNote === 'function') {
    const saved = await channel.setContactNote(
      clientId,
      buildPreAttendanceNote(session, normalizedService),
    ).catch(() => false);
    session.dados.noteSaved = saved !== false;
    session.dados.noteUpdatedAt = nowIso();
    Store.saveSession(session);
  }

  const unread = await markContactUnread(channel, clientId, {
    source: `pre-atendimento:${normalizedService}`,
    force: true,
  }).catch((err) => ({ marked: false, reason: err?.message || String(err) }));

  session.dados.awaitingSeller = true;
  session.dados.unreadMarkedForSeller = Boolean(unread?.marked);
  session.dados.unreadMarkedAt = unread?.marked ? nowIso() : null;
  Store.saveSession(session);

  console.log(
    `[PRÉ-ATENDIMENTO] ${normalizedService} concluído para ${clientId}; `
    + `não_lida=${String(Boolean(unread?.marked))}; pedido=#${orderNumber}`,
  );
  return session;
}

module.exports = {
  completePreAttendance,
  buildPreAttendanceNote,
  extractDemand,
};
