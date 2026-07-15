'use strict';

require('dotenv').config();

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocket, WebSocketServer } = require('ws');

const ACCESS_HOST = String(process.env.SESSION_ACCESS_HOST || '127.0.0.1').trim() || '127.0.0.1';
const ACCESS_PORT = Number(process.env.SESSION_ACCESS_PORT || 6080);
const ACCESS_PASSWORD = String(process.env.SESSION_ACCESS_PASSWORD || '2580');
const PUBLIC_URL = String(process.env.SESSION_ACCESS_PUBLIC_URL || '').trim().replace(/\/$/, '');
const BUSINESS_NAME = String(process.env.BUSINESS_NAME || 'Personalize').trim() || 'Personalize';
const VNC_HOST = String(process.env.SESSION_VNC_HOST || '127.0.0.1').trim() || '127.0.0.1';
const VNC_PORT = Number(process.env.SESSION_VNC_PORT || 5900);
const VNC_PASSWORD = String(process.env.SESSION_VNC_PASSWORD || ACCESS_PASSWORD);
const SESSION_COOKIE = 'personalize_session_access';
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.SESSION_ACCESS_TTL_MS || 12 * 60 * 60 * 1000));
const RFB_MODULE_PATH = require.resolve('@novnc/novnc/core/rfb.js');
const NOVNC_ROOT = path.resolve(path.dirname(RFB_MODULE_PATH), '..');
const activeTokens = new Map();

function now() { return Date.now(); }
function cleanExpiredTokens() {
  const current = now();
  for (const [token, expiresAt] of activeTokens.entries()) {
    if (expiresAt <= current) activeTokens.delete(token);
  }
}

function parseCookies(req) {
  const output = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [rawKey, ...rest] = part.split('=');
    const key = String(rawKey || '').trim();
    if (key) output[key] = decodeURIComponent(rest.join('=').trim());
  }
  return output;
}

function isAuthenticated(req) {
  cleanExpiredTokens();
  const token = parseCookies(req)[SESSION_COOKIE];
  const expiresAt = token ? activeTokens.get(token) : null;
  if (!token || !expiresAt || expiresAt <= now()) {
    if (token) activeTokens.delete(token);
    return false;
  }
  activeTokens.set(token, now() + SESSION_TTL_MS);
  return true;
}

function issueSession() {
  const token = crypto.randomBytes(24).toString('hex');
  activeTokens.set(token, now() + SESSION_TTL_MS);
  return token;
}

function requestIsHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function securityHeaders(req) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data:",
    ...(requestIsHttps(req) ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function setCookie(req, res, token) {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearCookie(req, res) {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function send(req, res, statusCode, body, contentType = 'text/html; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType, ...securityHeaders(req) });
  res.end(body);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function loginPage(error = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acessar WhatsApp Web</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#f8fafc;font-family:Arial,sans-serif}.card{width:min(92vw,430px);padding:26px;background:#111827;border:1px solid #2b3648;border-radius:18px;box-shadow:0 22px 60px rgba(0,0,0,.35)}h1{margin:0 0 10px;font-size:24px}p{color:#a8b3c7;line-height:1.5}input,button{width:100%;min-height:46px;border-radius:11px}input{margin:8px 0 14px;padding:0 13px;border:1px solid #3d4a60;background:#090d14;color:#fff}button{border:0;background:#f8fafc;color:#090d14;font-weight:800;cursor:pointer}.error{color:#fca5a5}.hint{font-size:13px;color:#78869a}</style></head><body><form class="card" method="POST" action="/login"><h1>${escapeHtml(BUSINESS_NAME)} — WhatsApp Web</h1><p>Entre para controlar diretamente a mesma tela do Chrome usada pela automação.</p><label for="password">Senha de acesso</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus>${error ? '<p class="error">Senha inválida.</p>' : ''}<button type="submit">Abrir WhatsApp Web</button><p class="hint">Este acesso permite responder, conectar e desconectar a sessão principal.</p></form></body></html>`;
}

function unavailablePage(error) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tela indisponível</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#fff;font-family:Arial,sans-serif}.box{width:min(92vw,520px);padding:28px;background:#111827;border:1px solid #3b4659;border-radius:18px}p{color:#b7c0cf;line-height:1.55}code{color:#fff}a{display:inline-block;padding:12px 16px;border-radius:10px;background:#fff;color:#111;text-decoration:none;font-weight:700}</style></head><body><div class="box"><h1>A tela do WhatsApp ainda não está disponível</h1><p>O link está funcionando, mas nenhum servidor VNC está compartilhando a área de trabalho em <code>${escapeHtml(`${VNC_HOST}:${VNC_PORT}`)}</code>.</p><p>Inicie o TightVNC ou UltraVNC compartilhando a área de trabalho onde o Chrome do WPPConnect está aberto.</p><p>Detalhe: ${escapeHtml(error?.message || error || 'conexão recusada')}</p><a href="/">Tentar novamente</a></div></body></html>`;
}

function viewerPage() {
  const password = JSON.stringify(VNC_PASSWORD);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>${escapeHtml(BUSINESS_NAME)} — WhatsApp Web</title><style>
  html,body,#screen{width:100%;height:100%;margin:0;overflow:hidden;background:#111}#screen{display:flex;align-items:center;justify-content:center}.top{position:fixed;z-index:20;top:10px;right:10px;display:flex;gap:8px}.top a{padding:8px 11px;border-radius:8px;background:rgba(15,23,42,.88);color:#fff;text-decoration:none;font:13px Arial,sans-serif;border:1px solid #475569}.status{position:fixed;z-index:20;left:10px;top:10px;padding:8px 11px;border-radius:8px;background:rgba(15,23,42,.88);color:#fff;font:13px Arial,sans-serif;border:1px solid #475569}</style></head><body><div class="status" id="status">Conectando à tela do WhatsApp…</div><div class="top"><a href="/logout">Sair</a></div><div id="screen"></div><script type="module">
  import RFB from '/novnc/core/rfb.js';
  const target = document.getElementById('screen');
  const status = document.getElementById('status');
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const rfb = new RFB(target, protocol + '://' + location.host + '/websockify', { credentials: { password: ${password} } });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.showDotCursor = true;
  rfb.viewOnly = false;
  rfb.addEventListener('connect', () => { status.textContent = 'WhatsApp Web conectado'; setTimeout(() => { status.style.display = 'none'; }, 1800); });
  rfb.addEventListener('disconnect', (event) => { status.style.display = 'block'; status.textContent = event.detail.clean ? 'Sessão encerrada' : 'Conexão com a tela perdida'; });
  rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: ${password} }));
</script></body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error('REQUEST_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[ext] || 'application/octet-stream';
}

function resolveNoVncPath(pathname) {
  const relative = pathname.replace(/^\/novnc\/?/, '');
  const resolved = path.resolve(NOVNC_ROOT, relative);
  return resolved.startsWith(NOVNC_ROOT) ? resolved : null;
}

function ensureVncAvailable(timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('VNC_TIMEOUT'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function accessUrls() {
  if (PUBLIC_URL) return [PUBLIC_URL];
  if (ACCESS_HOST !== '0.0.0.0' && ACCESS_HOST !== '::') return [`http://${ACCESS_HOST}:${ACCESS_PORT}`];
  const values = [];
  for (const entries of Object.values(os.networkInterfaces() || {})) {
    for (const item of entries || []) {
      if (item?.family === 'IPv4' && !item.internal) values.push(`http://${item.address}:${ACCESS_PORT}`);
    }
  }
  values.push(`http://localhost:${ACCESS_PORT}`);
  return [...new Set(values)];
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${ACCESS_HOST}:${ACCESS_PORT}`}`);
  const { pathname } = requestUrl;

  if (pathname === '/favicon.ico') return send(req, res, 204, '', 'text/plain');
  if (pathname === '/health') {
    let available = false;
    let error = null;
    try { await ensureVncAvailable(700); available = true; } catch (err) { error = String(err?.message || err); }
    return send(req, res, 200, JSON.stringify({ ok: true, vncAvailable: available, vncError: error, vncHost: VNC_HOST, vncPort: VNC_PORT, accessUrls: accessUrls() }), 'application/json; charset=utf-8');
  }

  if (pathname === '/logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) activeTokens.delete(token);
    clearCookie(req, res);
    res.writeHead(302, { Location: '/', ...securityHeaders(req) });
    return res.end();
  }

  if (pathname === '/login' && req.method === 'POST') {
    try {
      const form = new URLSearchParams(await readBody(req));
      if (String(form.get('password') || '') !== ACCESS_PASSWORD) return send(req, res, 401, loginPage(true));
      setCookie(req, res, issueSession());
      res.writeHead(302, { Location: '/', ...securityHeaders(req) });
      return res.end();
    } catch (_) {
      return send(req, res, 400, loginPage(true));
    }
  }

  if (!isAuthenticated(req)) return send(req, res, 200, loginPage(false));

  if (pathname === '/' || pathname === '/viewer') {
    try {
      await ensureVncAvailable();
      return send(req, res, 200, viewerPage());
    } catch (error) {
      return send(req, res, 503, unavailablePage(error));
    }
  }

  if (pathname.startsWith('/novnc/')) {
    const filePath = resolveNoVncPath(pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath), ...securityHeaders(req) });
    return fs.createReadStream(filePath).pipe(res);
  }

  return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  const socket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });
  socket.on('data', (chunk) => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true }); });
  socket.on('error', () => { try { ws.close(); } catch (_) {} });
  socket.on('close', () => { try { ws.close(); } catch (_) {} });
  ws.on('message', (data) => socket.write(data));
  ws.on('close', () => socket.destroy());
  ws.on('error', () => socket.destroy());
});

server.on('upgrade', async (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${ACCESS_HOST}:${ACCESS_PORT}`}`);
  if (requestUrl.pathname !== '/websockify' || !isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  try {
    await ensureVncAvailable(1000);
  } catch (_) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.log(`[session-access] o acesso direto já está ativo na porta ${ACCESS_PORT}`);
    process.exitCode = 0;
    return;
  }
  console.error('[session-access] erro no acesso direto:', error?.message || error);
  process.exitCode = 1;
});

server.listen(ACCESS_PORT, ACCESS_HOST, async () => {
  console.log('');
  console.log('[session-access] acesso direto ao WhatsApp Web iniciado');
  for (const url of accessUrls()) console.log(`[session-access] link: ${url}`);
  try {
    await ensureVncAvailable();
    console.log(`[session-access] mesma área de trabalho disponível em ${VNC_HOST}:${VNC_PORT}`);
  } catch (error) {
    console.warn(`[session-access] link ativo, mas nenhuma área de trabalho está sendo compartilhada em ${VNC_HOST}:${VNC_PORT}`);
    console.warn('[session-access] inicie o TightVNC/UltraVNC na área onde o Chrome do WPPConnect está aberto.');
    console.warn(`[session-access] detalhe: ${error?.message || error}`);
  }
  console.log('');
});
