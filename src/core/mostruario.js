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

function getMostruarioPdfPath() {
  const explicit = String(env.mostruarioLetreiroPdfPath || '').trim();
  if (explicit) {
    const filePath = path.resolve(process.cwd(), explicit);
    if (fs.existsSync(filePath)) return filePath;
    console.warn(`[ASSET] PDF configurado não encontrado: ${filePath}`);
  }

  return resolveAssetPath([
    env.mostruarioLetreiroPdfBaseName || 'mostruario',
    'mostruario',
    'Mostruario_Letreiro',
    'mostruario-letreiro',
  ], ['.pdf']);
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

function normalizeChatId(clientId) {
  const raw = String(clientId || '').trim();
  if (!raw) return '';
  if (/@(c\.us|g\.us|lid)$/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : raw;
}

function imageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function imageToDataUri(filePath) {
  const buffer = fs.readFileSync(filePath);
  return `data:${imageMimeType(filePath)};base64,${buffer.toString('base64')}`;
}

async function sendImageWithUrlButton(channel, clientId, filePath, pdfUrl) {
  if (!filePath || !pdfUrl || !channel?.client?.page?.evaluate) return false;

  const chatId = normalizeChatId(clientId);
  const filename = path.basename(filePath);
  const caption = String(messages.mostruario || '').trim();
  const buttonText = String(messages.mostruarioLink || 'Ver Mostruário')
    .replace(/^🔗\s*/u, '')
    .trim() || 'Ver Mostruário';

  let dataUri;
  try {
    dataUri = imageToDataUri(filePath);
  } catch (err) {
    console.warn('[MOSTRUARIO CTA] não foi possível ler a imagem:', err?.message || err);
    return false;
  }

  try {
    console.log(`[MOSTRUARIO CTA] tentando imagem + botão para ${chatId}`);
    const result = await channel.client.page.evaluate(async (payload) => {
      const WPP = window.WPP || null;
      if (!WPP?.chat?.sendFileMessage) {
        return { ok: false, reason: 'WPP.chat.sendFileMessage indisponível' };
      }

      const sent = await WPP.chat.sendFileMessage(payload.chatId, payload.dataUri, {
        type: 'image',
        filename: payload.filename,
        caption: payload.caption,
        buttons: [
          {
            url: payload.pdfUrl,
            text: payload.buttonText,
          },
        ],
        waitForAck: true,
        markIsRead: false,
      });

      return {
        ok: true,
        id: sent?.id || null,
        ack: sent?.ack ?? null,
      };
    }, {
      chatId,
      dataUri,
      filename,
      caption,
      pdfUrl,
      buttonText,
    });

    if (result?.ok) {
      console.log(`[MOSTRUARIO CTA] card enviado com botão "${buttonText}". ACK: ${result.ack ?? 'indisponível'}`);
      return true;
    }

    console.warn('[MOSTRUARIO CTA] card não enviado:', result?.reason || 'retorno desconhecido');
    return false;
  } catch (err) {
    console.warn('[MOSTRUARIO CTA] falhou; usando fallback imagem + link:', err?.message || err);
    return false;
  }
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
    console.log(`[ASSET] envio solicitado com sucesso: ${path.basename(filePath)}`);
    return result !== false;
  } catch (err) {
    console.warn('[ASSET] não foi possível enviar imagem:', filePath, err?.message || err);
    return false;
  }
}

async function sendMostruarioLetreiro(channel, clientId) {
  const imagePath = getMostruarioImagePath();
  const pdfPath = getMostruarioPdfPath();
  const pdfUrl = String(env.mostruarioLetreiroPdfUrl || '').trim();

  // Caminho principal: card nativo com imagem e botão CTA abrindo o PDF online.
  if (imagePath && pdfUrl) {
    const nativeCardSent = await sendImageWithUrlButton(channel, clientId, imagePath, pdfUrl);
    if (nativeCardSent) return;
    console.warn('[MOSTRUARIO CTA] seguindo com fallback compatível.');
  }

  // Fallback seguro: imagem normal seguida do link ou do PDF local.
  if (imagePath) {
    const ok = await sendImageIfExists(channel, clientId, imagePath, messages.mostruario);
    if (!ok) await channel.sendText(clientId, messages.mostruario);
  } else {
    await channel.sendText(clientId, messages.mostruario);
  }

  if (pdfUrl) {
    await channel.sendText(clientId, `${messages.mostruarioLink}: ${pdfUrl}`);
    return;
  }

  if (pdfPath && channel?.sendDocument) {
    try {
      console.log(`[ASSET] enviando PDF: ${pdfPath}`);
      const ok = await channel.sendDocument(clientId, pdfPath, 'mostruario.pdf', 'Confira nosso mostruário de Letreiros e Cores.');
      if (ok) return;
    } catch (err) {
      console.warn('[MOSTRUARIO] não foi possível enviar PDF:', err?.message || err);
    }
  }
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
  getMostruarioPdfPath,
  getTabelaCoresPath,
  getTabelaEspessuraPath,
  getTabelaProfundidadePath,
  listAssetFiles,
  sendImageWithUrlButton,
};
