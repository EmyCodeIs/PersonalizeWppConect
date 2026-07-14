'use strict';

require('dotenv').config();

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocket, WebSocketServer } = require('ws');

const ACCESS_HOST = String(process.env.SESSION_ACCESS_HOST || '127.0.0.1').trim() || '127.0.0.1';
const ACCESS_PORT = Number(process.env.SESSION_ACCESS_PORT || 6080);
const ACCESS_PASSWORD = String(process.env.SESSION_ACCESS_PASSWORD || '2580');
const VNC_HOST = String(process.env.SESSION_VNC_HOST || '127.0.0.1').trim() || '127.0.0.1';
const VNC_PORT = Number(process.env.SESSION_VNC_PORT || 5900);
const VNC_PASSWORD = String(process.env.SESSION_VNC_PASSWORD || ACCESS_PASSWORD);
const SESSION_COOKIE = 'personalize_session_access';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const NOVNC_ROOT = path.dirname(require.resolve('@novnc/novnc/package.json'));
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

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function send(res, statusCode, body, contentType = 'text/html; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function layout(title, content) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
  body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{width:min(92vw,460px);background:#111827;border:1px solid #334155;border-radius:16px;padding:24px;box-shadow:0 20px 40px rgba(0,0,0,.35)}h1{margin:0 0 12px;font-size:22px}p{color:#94a3b8;line-height:1.5}input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;margin:10px 0 14px}button,.button{display:block;width:100%;box-sizing:border-box;padding:12px 14px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}.error{color:#fca5a5}.ok{color:#86efac}.hint{font-size:13px;color:#64748b;margin-top:12px}code{color:#e2e8f0;background:#0f172a;padding:2px 5px;border-radius:5px}</style></head><body><div class="card">${content}</div></body></html>`;
}

function loginPage(error = false) {
  return layout('Acesso à sessão do WhatsApp', `<h1>Sessão do WhatsApp Web</h1><p>Digite a senha para abrir a mesma tela do Chrome usada pelo sistema.</p><form method="POST" action="/login"><label for="password">Senha</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus>${error ? '<p class="error">Senha inválida.</p>' : ''}<button type="submit">Entrar</button></form><p class="hint">Acesso local protegido.</p>`);
}

function unavailablePage(error) {
  return layout('Link ativo — VNC indisponível', `<h1>O link está ativo</h1><p class="error">Ainda não foi possível acessar a tela do Windows.</p><p>O servidor VNC precisa estar ligado em <code>${VNC_HOST}:${VNC_PORT}</code>. Abra o TightVNC Server ou UltraVNC Server e recarregue esta página.</p><p class="hint">Detalhe: ${String(error?.message || error || 'conexão recusada')}</p><a class="button" href="/viewer">Tentar novamente</a>`);
}

function viewerRedirectPage() {
  const url = `/novnc/vnc.html?autoconnect=1&resize=remote&show_dot=1&path=websockify&password=${encodeURIComponent(VNC_PASSWORD)}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${url}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Abrindo sessão</title></head><body><a href="${url}">Abrir sessão</a></body></html>`;
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
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

function resolveNoVncPath(pathname) {
  const relative = pathname.replace(/^\/novnc\/?/, '');
  const resolved = path.resolve(NOVNC_ROOT, relative || 'vnc.html');
  return resolved.startsWith(NOVNC_ROOT) ? resolved : null;
}

function ensureVncAvailable(timeoutMs = 1800) {
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
    socket.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${ACCESS_HOST}:${ACCESS_PORT}`}`);
  const { pathname } = requestUrl;

  if (pathname === '/favicon.ico') return send(res, 204, '', 'text/plain');
  if (pathname === '/health') {
    let vncAvailable = false;
    let vncError = null;
    try { await ensureVncAvailable(700); vncAvailable = true; } catch (err) { vncError = String(err?.message || err); }
    return send(res, 200, JSON.stringify({ ok: true, vncAvailable, vncError, vncHost: VNC_HOST, vncPort: VNC_PORT, accessHost: ACCESS_HOST, accessPort: ACCESS_PORT }), 'application/json; charset=utf-8');
  }
  if (pathname === '/logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) activeTokens.delete(token);
    clearCookie(res);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  if (pathname === '/login' && req.method === 'POST') {
    try {
      const form = new URLSearchParams(await readBody(req));
      if (String(form.get('password') || '') !== ACCESS_PASSWORD) return send(res, 401, loginPage(true));
      setCookie(res, issueSession());
      res.writeHead(302, { Location: '/viewer' });
      return res.end();
    } catch (_) {
      return send(res, 400, loginPage(true));
    }
  }
  if (pathname === '/' && !isAuthenticated(req)) return send(res, 200, loginPage(false));
  if (!isAuthenticated(req)) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  if (pathname === '/' || pathname === '/viewer') {
    try {
      await ensureVncAvailable();
      return send(res, 200, viewerRedirectPage());
    } catch (err) {
      return send(res, 503, unavailablePage(err));
    }
  }
  if (pathname.startsWith('/novnc/')) {
    const filePath = resolveNoVncPath(pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath), 'Cache-Control': 'no-store' });
    return fs.createReadStream(filePath).pipe(res);
  }
  return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
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

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.log(`[session-access] o link já está ativo em http://${ACCESS_HOST}:${ACCESS_PORT}`);
    process.exitCode = 0;
    return;
  }
  console.error('[session-access] erro no servidor local:', err?.message || err);
  process.exitCode = 1;
});

server.listen(ACCESS_PORT, ACCESS_HOST, async () => {
  console.log('');
  console.log('[session-access] link local iniciado junto com o sistema');
  console.log(`[session-access] link: http://${ACCESS_HOST}:${ACCESS_PORT}`);
  console.log(`[session-access] senha: ${ACCESS_PASSWORD}`);
  try {
    await ensureVncAvailable();
    console.log(`[session-access] VNC conectado em ${VNC_HOST}:${VNC_PORT}`);
  } catch (err) {
    console.warn(`[session-access] link aberto, mas o VNC ainda não está disponível em ${VNC_HOST}:${VNC_PORT}`);
    console.warn('[session-access] inicie o TightVNC Server ou UltraVNC Server e atualize a página.');
    console.warn(`[session-access] detalhe: ${err?.message || err}`);
  }
  console.log('');
});
