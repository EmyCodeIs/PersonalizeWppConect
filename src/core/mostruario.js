'use strict';

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');
const { messages } = require('./messages');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

function normalizeAssetName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function getAssetsDir() {
  return path.resolve(process.cwd(), env.assetsDir || 'assets');
}

function listAssetFiles() {
  const dir = getAssetsDir();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (err) {
    console.warn(`[ASSET] não foi possível listar ${dir}:`, err?.message || err);
    return [];
  }
}

function resolveAssetPath(baseNameOrNames, extensions) {
  const dir = getAssetsDir();
  const names = Array.isArray(baseNameOrNames) ? baseNameOrNames : [baseNameOrNames];

  if (!fs.existsSync(dir)) {
    console.warn(`[ASSET] pasta não encontrada: ${dir}`);
    return null;
  }

  for (const rawName of names) {
    const baseName = String(rawName || '').trim();
    if (!baseName) continue;

    if (path.extname(baseName)) {
      const explicit = path.join(dir, baseName);
      if (fs.existsSync(explicit)) return explicit;
    }

    for (const ext of extensions) {
      const exactPath = path.join(dir, `${baseName}${ext}`);
      if (fs.existsSync(exactPath)) return exactPath;
    }
  }

  const files = listAssetFiles();
  const normalizedTargets = names.map(normalizeAssetName).filter(Boolean);
  const match = files.find((fileName) => {
    const ext = path.extname(fileName).toLowerCase();
    if (!extensions.includes(ext)) return false;
    return normalizedTargets.includes(normalizeAssetName(fileName));
  });

  if (match) return path.join(dir, match);

  console.warn(`[ASSET] arquivo não encontrado. Procurados: ${names.join(', ')} | Pasta: ${dir}`);
  console.warn(`[ASSET] arquivos disponíveis: ${files.join(', ') || '(pasta vazia)'}`);
  return null;
}

function getMostruarioImagePath() {
  return resolveAssetPath([
    env.mostruarioLetreiroImageBaseName || 'capa-mostruario',
    'capa-mostruario',
    'Mostruario_Letreiro',
    'mostruario-letreiro',
  ], IMAGE_EXTENSIONS);
}

function getTabelaCoresPath() {
  return resolveAssetPath([
    env.assetTabelaCoresBaseName || 'tabela-cores-v2',
    'tabela-cores-v2',
    'tabela-cores',
  ], IMAGE_EXTENSIONS);
}

function getTabelaEspessuraPath() {
  return resolveAssetPath([
    env.assetTabelaEspessuraBaseName || 'tabela-espessura',
    'tabela-espessura',
    'espessura',
  ], IMAGE_EXTENSIONS);
}

function getTabelaProfundidadePath() {
  return resolveAssetPath([
    env.assetTabelaProfundidadeBaseName || 'tabela-profundidade-3mm',
    'tabela-profundidade-3mm',
    'tabela-profundidade',
    'profundidade-3mm',
  ], IMAGE_EXTENSIONS);
}

async function sendImageIfExists(channel, clientId, filePath, caption) {
  if (!filePath) return false;
  if (!channel?.sendImage) {
    console.warn('[ASSET] canal atual não possui sendImage.');
    return false;
  }

  console.log(`[ASSET] enviando imagem: ${filePath}`);
  try {
    const result = await channel.sendImage(clientId, filePath, caption || '');
    console.log(`[ASSET] imagem enviada: ${path.basename(filePath)}`);
    return result !== false;
  } catch (err) {
    console.warn('[ASSET] não foi possível enviar imagem:', filePath, err?.message || err);
    return false;
  }
}

function getMostruarioLink() {
  const link = String(env.mostruarioLinkUrl || '').trim();
  if (/^https?:\/\/[^\s]+$/i.test(link)) return link;

  console.warn('[MOSTRUARIO] MOSTRUARIO_LINK_URL inválida; usando link provisório.');
  return 'https://personalizeseuambiente.com.br/mostruario-letreiros';
}

async function sendMostruarioLetreiro(channel, clientId) {
  const imagePath = getMostruarioImagePath();
  const link = getMostruarioLink();

  if (imagePath) {
    const ok = await sendImageIfExists(channel, clientId, imagePath, messages.mostruario);
    if (!ok) await channel.sendText(clientId, messages.mostruario);
  } else {
    await channel.sendText(clientId, messages.mostruario);
  }

  await channel.sendText(
    clientId,
    `${messages.mostruarioLink || '🔗 Ver Mostruário'}\n${link}`,
  );

  console.log(`[MOSTRUARIO] link comum enviado: ${link}`);
  return true;
}

async function sendTabelaCores(channel, clientId) {
  return sendImageIfExists(channel, clientId, getTabelaCoresPath(), 'Confira nossa tabela de cores disponíveis.');
}

async function sendTabelaEspessura(channel, clientId) {
  return sendImageIfExists(channel, clientId, getTabelaEspessuraPath(), 'Referência de espessuras do acrílico.');
}

async function sendTabelaProfundidade(channel, clientId) {
  return sendImageIfExists(channel, clientId, getTabelaProfundidadePath(), 'Referência de profundidade com acrílico cristal por trás.');
}

module.exports = {
  sendMostruarioLetreiro,
  sendTabelaCores,
  sendTabelaEspessura,
  sendTabelaProfundidade,
  getMostruarioImagePath,
  getTabelaCoresPath,
  getTabelaEspessuraPath,
  getTabelaProfundidadePath,
  listAssetFiles,
  getMostruarioLink,
};
