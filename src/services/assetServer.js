'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { env } = require('../config/env');
const { getMostruarioPdfPath } = require('../core/mostruario');

let serverInstance = null;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getLanIpv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : String(entry.family);
      if (family === 'IPv4' && !entry.internal && entry.address) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

function sendJson(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(payload);
}

function servePdf(request, response, pdfPath) {
  let stat;
  try {
    stat = fs.statSync(pdfPath);
  } catch (error) {
    sendJson(response, 404, { ok: false, error: 'pdf_not_found' });
    return;
  }

  const total = stat.size;
  const range = request.headers.range;
  const commonHeaders = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="mostruario.pdf"',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, { ...commonHeaders, 'Content-Length': total });
    response.end();
    return;
  }

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${total}` });
      response.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
      response.writeHead(416, { 'Content-Range': `bytes */${total}` });
      response.end();
      return;
    }

    const safeEnd = Math.min(end, total - 1);
    response.writeHead(206, {
      ...commonHeaders,
      'Content-Range': `bytes ${start}-${safeEnd}/${total}`,
      'Content-Length': safeEnd - start + 1,
    });
    fs.createReadStream(pdfPath, { start, end: safeEnd }).pipe(response);
    return;
  }

  response.writeHead(200, { ...commonHeaders, 'Content-Length': total });
  fs.createReadStream(pdfPath).pipe(response);
}

function buildPublicBaseUrl() {
  const configured = normalizeBaseUrl(env.assetPublicBaseUrl);
  if (configured) return configured;
  return `http://${getLanIpv4()}:${env.assetServerPort}`;
}

async function startAssetServer() {
  const explicitUrl = normalizeBaseUrl(env.mostruarioLetreiroPdfUrl);
  if (explicitUrl) {
    console.log(`[ASSET SERVER] usando URL externa configurada: ${explicitUrl}`);
    return { started: false, url: explicitUrl, source: 'external' };
  }

  if (!env.enableAssetServer) {
    console.warn('[ASSET SERVER] desativado e nenhuma URL externa foi configurada.');
    return { started: false, url: '', source: 'disabled' };
  }

  const pdfPath = getMostruarioPdfPath();
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    console.warn('[ASSET SERVER] mostruario.pdf não encontrado; nenhum link será enviado.');
    return { started: false, url: '', source: 'missing' };
  }

  if (serverInstance) {
    return { started: true, url: env.mostruarioLetreiroPdfUrl, source: 'local' };
  }

  serverInstance = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');

    if (requestUrl.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'personalize-assets' });
      return;
    }

    if (requestUrl.pathname === '/mostruario.pdf') {
      servePdf(request, response, pdfPath);
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not_found' });
  });

  await new Promise((resolve, reject) => {
    serverInstance.once('error', reject);
    serverInstance.listen(env.assetServerPort, env.assetServerHost, () => {
      serverInstance.off('error', reject);
      resolve();
    });
  });

  const publicBaseUrl = buildPublicBaseUrl();
  const publicPdfUrl = `${publicBaseUrl}/mostruario.pdf`;
  env.mostruarioLetreiroPdfUrl = publicPdfUrl;

  console.log(`[ASSET SERVER] PDF disponível em: ${publicPdfUrl}`);
  if (!env.assetPublicBaseUrl) {
    console.warn('[ASSET SERVER] link local: funciona apenas para dispositivos que conseguem acessar este notebook/rede.');
    console.warn('[ASSET SERVER] para clientes externos, configure ASSET_PUBLIC_BASE_URL com domínio ou túnel público.');
  }

  return {
    started: true,
    url: publicPdfUrl,
    source: env.assetPublicBaseUrl ? 'public-base' : 'lan',
    pdfPath: path.resolve(pdfPath),
  };
}

module.exports = {
  startAssetServer,
  getLanIpv4,
};