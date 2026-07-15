'use strict';

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const imageDataUriCache = new Map();

function normalizeAssetName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
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

function getBemVindosImagePath() {
  return resolveAssetPath([
    env.bemVindosImageBaseName || 'capa_bem_vindos',
    'capa_bem_vindos.jpg.jpeg',
    'capa_bem_vindos',
    'capa-bem-vindos',
    'capa_bem-vindos',
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

function getFileSizeKb(filePath) {
  try {
    return Math.round(fs.statSync(filePath).size / 1024);
  } catch (_) {
    return null;
  }
}

function filePathToDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) return null;

  const cacheKey = path.resolve(process.cwd(), filePath);
  if (imageDataUriCache.has(cacheKey)) return imageDataUriCache.get(cacheKey);

  try {
    const content = fs.readFileSync(cacheKey);
    const dataUri = `data:${mimeType};base64,${content.toString('base64')}`;
    imageDataUriCache.set(cacheKey, dataUri);
    return dataUri;
  } catch (err) {
    console.warn('[ASSET] nao foi possivel carregar imagem em base64:', filePath, err?.message || err);
    return null;
  }
}

async function sendImageCaptionFast(channel, clientId, filePath, caption = '') {
  if (!filePath) return false;

  const fullPath = path.resolve(process.cwd(), filePath);

  if (typeof channel?.sendImage === 'function') {
    await channel.sendImage(clientId, fullPath, caption || '', {
      noDelay: true,
      noTyping: true,
    });
    return true;
  }

  const chatId = normalizeChatId(clientId);
  const filename = path.basename(fullPath);
  if (typeof channel?.client?.sendImage === 'function') {
    await channel.client.sendImage(chatId, fullPath, filename, String(caption || ''));
    return true;
  }

  return false;
}

async function sendImageIfExists(channel, clientId, filePath, caption = '', options = {}) {
  if (!filePath) return false;
  if (!channel?.sendImage && !channel?.client?.sendImage) {
    console.warn('[ASSET] canal atual não possui sendImage.');
    return false;
  }

  const sizeKb = getFileSizeKb(filePath);
  console.log(`[ASSET] enviando imagem: ${filePath}${sizeKb ? ` (${sizeKb} KB)` : ''}`);
  const startedAt = Date.now();

  try {
    let result;

    if (typeof channel?.sendImage === 'function') {
      result = await channel.sendImage(clientId, filePath, caption || '', {
        noDelay: Boolean(options.fast),
        noTyping: Boolean(options.fast),
      });
    } else {
      const chatId = normalizeChatId(clientId);
      const fullPath = path.resolve(process.cwd(), filePath);
      result = await channel.client.sendImage(
        chatId,
        fullPath,
        path.basename(fullPath),
        String(caption || ''),
      );
    }

    console.log(`[ASSET] imagem enviada: ${path.basename(filePath)} em ${Date.now() - startedAt}ms`);
    return result !== false;
  } catch (err) {
    console.warn('[ASSET] não foi possível enviar imagem:', filePath, err?.message || err);
    return false;
  }
}

async function sendTextFast(channel, clientId, text, logPrefix = 'LINK') {
  const startedAt = Date.now();

  if (typeof channel?.sendText === 'function') {
    await channel.sendText(clientId, text, {
      noDelay: true,
      noTyping: true,
    });
  } else {
    const chatId = normalizeChatId(clientId);
    await channel.client.sendText(chatId, String(text || ''));
  }

  console.log(`[${logPrefix}] enviado em ${Date.now() - startedAt}ms`);
}

function validRawLink(value, variableName, fallback) {
  const link = String(value || '').trim();
  if (/^https?:\/\/[^\s]+$/i.test(link)) return link;
  console.warn(`[LINK] ${variableName} inválida; usando link provisório.`);
  return fallback;
}

function getBemVindosLink() {
  return validRawLink(
    env.bemVindosLinkUrl,
    'BEM_VINDOS_LINK_URL',
    'https://personalizeseuambiente.com.br/bem-vindos',
  );
}

async function sendLinkedImage(channel, clientId, { imagePath, link, label }) {
  const totalStartedAt = Date.now();

  if (imagePath) {
    const ok = await sendImageCaptionFast(channel, clientId, imagePath, link);
    if (!ok) {
      console.warn(`[${label}] falha no envio da imagem; usando link cru como fallback.`);
      await sendTextFast(channel, clientId, link, `${label} LINK FALLBACK`);
    }
  } else {
    console.warn(`[${label}] imagem não encontrada; enviando somente o link cru como fallback.`);
    await sendTextFast(channel, clientId, link, `${label} LINK FALLBACK`);
  }

  console.log(`[${label}] imagem com URL crua na legenda concluída em ${Date.now() - totalStartedAt}ms`);
  return true;
}

async function sendBemVindos(channel, clientId) {
  return sendLinkedImage(channel, clientId, {
    imagePath: getBemVindosImagePath(),
    link: getBemVindosLink(),
    label: 'BEM-VINDOS',
  });
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

[
  getBemVindosImagePath(),
  getTabelaCoresPath(),
  getTabelaEspessuraPath(),
  getTabelaProfundidadePath(),
].forEach((assetPath) => {
  if (assetPath) filePathToDataUri(assetPath);
});

module.exports = {
  sendBemVindos,
  sendTabelaCores,
  sendTabelaEspessura,
  sendTabelaProfundidade,
  getBemVindosImagePath,
  getTabelaCoresPath,
  getTabelaEspessuraPath,
  getTabelaProfundidadePath,
  listAssetFiles,
  getBemVindosLink,
};
