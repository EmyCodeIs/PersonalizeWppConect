'use strict';

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { messages } = require('./messages');

function resolveAssetPath(baseName, extensions) {
  const dir = path.resolve(process.cwd(), env.assetsDir || 'assets');
  for (const ext of extensions) {
    const filePath = path.join(dir, `${baseName}${ext}`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function getMostruarioImagePath() {
  return resolveAssetPath(env.mostruarioLetreiroImageBaseName || 'Mostruario_Letreiro', ['.png', '.jpg', '.jpeg', '.webp']);
}

function getMostruarioPdfPath() {
  const explicit = String(env.mostruarioLetreiroPdfPath || '').trim();
  if (explicit) {
    const filePath = path.resolve(process.cwd(), explicit);
    if (fs.existsSync(filePath)) return filePath;
  }
  return resolveAssetPath(env.mostruarioLetreiroImageBaseName || 'Mostruario_Letreiro', ['.pdf']);
}

async function sendMostruarioLetreiro(channel, clientId) {
  const imagePath = getMostruarioImagePath();
  const pdfPath = getMostruarioPdfPath();
  const pdfUrl = String(env.mostruarioLetreiroPdfUrl || '').trim();

  if (imagePath && channel?.sendImage) {
    const ok = await channel.sendImage(clientId, imagePath, messages.mostruario).catch((err) => {
      console.warn('[MOSTRUARIO] não foi possível enviar imagem:', err?.message || err);
      return false;
    });
    if (!ok) await channel.sendText(clientId, messages.mostruario);
  } else {
    await channel.sendText(clientId, messages.mostruario);
  }

  if (pdfUrl) {
    // CTA URL estilo API oficial não é garantido no WPPConnect; o link é o fallback mais estável.
    await channel.sendText(clientId, `${messages.mostruarioLink}: ${pdfUrl}`);
    return;
  }

  if (pdfPath && channel?.sendDocument) {
    const ok = await channel.sendDocument(clientId, pdfPath, 'Mostruario_Letreiro.pdf', 'Confira nosso mostruário de Letreiros e Cores.').catch((err) => {
      console.warn('[MOSTRUARIO] não foi possível enviar PDF:', err?.message || err);
      return false;
    });
    if (ok) return;
  }

  if (!imagePath && !pdfPath && !pdfUrl) {
    console.warn('[MOSTRUARIO] Nenhum asset/link configurado. Coloque assets/Mostruario_Letreiro.png ou MOSTRUARIO_LETREIRO_PDF_URL no .env.');
  }
}

module.exports = {
  sendMostruarioLetreiro,
  getMostruarioImagePath,
  getMostruarioPdfPath,
};
