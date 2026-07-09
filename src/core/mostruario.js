'use strict';

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { messages } = require('./messages');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

function resolveAssetPath(baseNameOrNames, extensions) {
  const dir = path.resolve(process.cwd(), env.assetsDir || 'assets');
  const names = Array.isArray(baseNameOrNames) ? baseNameOrNames : [baseNameOrNames];

  for (const rawName of names) {
    const baseName = String(rawName || '').trim();
    if (!baseName) continue;

    if (path.extname(baseName)) {
      const explicit = path.join(dir, baseName);
      if (fs.existsSync(explicit)) return explicit;
    }

    for (const ext of extensions) {
      const filePath = path.join(dir, `${baseName}${ext}`);
      if (fs.existsSync(filePath)) return filePath;
    }
  }
  return null;
}

function getMostruarioImagePath() {
  return resolveAssetPath([
    env.mostruarioLetreiroImageBaseName || 'capa-mostruario',
    'capa-mostruario',
    'Mostruario_Letreiro',
  ], IMAGE_EXTENSIONS);
}

function getMostruarioPdfPath() {
  const explicit = String(env.mostruarioLetreiroPdfPath || '').trim();
  if (explicit) {
    const filePath = path.resolve(process.cwd(), explicit);
    if (fs.existsSync(filePath)) return filePath;
  }

  return resolveAssetPath([
    env.mostruarioLetreiroPdfBaseName || 'mostruario',
    'mostruario',
    env.mostruarioLetreiroImageBaseName || 'capa-mostruario',
    'Mostruario_Letreiro',
  ], ['.pdf']);
}

function getTabelaCoresPath() {
  return resolveAssetPath([
    env.assetTabelaCoresBaseName || 'tabela-cores-v2',
    'tabela-cores-v2',
  ], IMAGE_EXTENSIONS);
}

function getTabelaEspessuraPath() {
  return resolveAssetPath([
    env.assetTabelaEspessuraBaseName || 'tabela-espessura',
    'tabela-espessura',
  ], IMAGE_EXTENSIONS);
}

function getTabelaProfundidadePath() {
  return resolveAssetPath([
    env.assetTabelaProfundidadeBaseName || 'tabela-profundidade-3mm',
    'tabela-profundidade-3mm',
  ], IMAGE_EXTENSIONS);
}

async function sendImageIfExists(channel, clientId, filePath, caption) {
  if (!filePath || !channel?.sendImage) return false;
  return channel.sendImage(clientId, filePath, caption || '').catch((err) => {
    console.warn('[ASSET] não foi possível enviar imagem:', filePath, err?.message || err);
    return false;
  });
}

async function sendMostruarioLetreiro(channel, clientId) {
  const imagePath = getMostruarioImagePath();
  const pdfPath = getMostruarioPdfPath();
  const pdfUrl = String(env.mostruarioLetreiroPdfUrl || '').trim();

  if (imagePath) {
    const ok = await sendImageIfExists(channel, clientId, imagePath, messages.mostruario);
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
    const ok = await channel.sendDocument(clientId, pdfPath, 'mostruario.pdf', 'Confira nosso mostruário de Letreiros e Cores.').catch((err) => {
      console.warn('[MOSTRUARIO] não foi possível enviar PDF:', err?.message || err);
      return false;
    });
    if (ok) return;
  }

  if (!imagePath && !pdfPath && !pdfUrl) {
    console.warn('[MOSTRUARIO] Nenhum asset/link configurado. Coloque assets/capa-mostruario.png e/ou assets/mostruario.pdf.');
  }
}

async function sendTabelaCores(channel, clientId) {
  const imagePath = getTabelaCoresPath();
  return sendImageIfExists(channel, clientId, imagePath, 'Confira nossa tabela de cores disponíveis.');
}

async function sendTabelaEspessura(channel, clientId) {
  const imagePath = getTabelaEspessuraPath();
  return sendImageIfExists(channel, clientId, imagePath, 'Referência de espessuras do acrílico.');
}

async function sendTabelaProfundidade(channel, clientId) {
  const imagePath = getTabelaProfundidadePath();
  return sendImageIfExists(channel, clientId, imagePath, 'Referência de profundidade com acrílico cristal por trás.');
}

module.exports = {
  sendMostruarioLetreiro,
  sendTabelaCores,
  sendTabelaEspessura,
  sendTabelaProfundidade,
  getMostruarioImagePath,
  getMostruarioPdfPath,
  getTabelaCoresPath,
  getTabelaEspessuraPath,
  getTabelaProfundidadePath,
};
