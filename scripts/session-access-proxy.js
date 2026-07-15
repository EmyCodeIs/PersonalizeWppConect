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

function requestIsHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function setCookie(req, res, token) {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
  );
}

function clearCookie(req, res) {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function securityHeaders(req) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-src 'self'",
    ...(requestIsHttps(req) ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function send(req, res, statusCode, body, contentType = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    ...securityHeaders(req),
    ...headers,
  });
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

function layout(title, content) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{font-family:Inter,Arial,sans-serif;background:#090d14;color:#f8fafc;min-height:100vh;margin:0}.shell{width:min(94vw,920px);margin:0 auto;padding:32px 0}.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px}.logo{width:42px;height:42px;border-radius:13px;background:#f8fafc;color:#090d14;display:grid;place-items:center;font-weight:900}.brand small{display:block;color:#94a3b8;margin-top:3px}.card{background:#111827;border:1px solid #273449;border-radius:20px;padding:24px;box-shadow:0 22px 60px rgba(0,0,0,.32)}.login{max-width:460px;margin:9vh auto 0}.grid{display:grid;grid-template-columns:1.25fr .75fr;gap:18px}.status{display:flex;align-items:center;gap:10px;padding:13px 14px;background:#0b1220;border:1px solid #273449;border-radius:14px}.dot{width:10px;height:10px;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 5px rgba(245,158,11,.12)}.dot.ok{background:#22c55e;box-shadow:0 0 0 5px rgba(34,197,94,.12)}.dot.bad{background:#ef4444;box-shadow:0 0 0 5px rgba(239,68,68,.12)}h1{margin:0 0 8px;font-size:25px}h2{font-size:17px;margin:0 0 12px}p{color:#a8b3c7;line-height:1.55;margin:8px 0}.warning{background:#291e0d;border:1px solid #6b4b13;color:#fde68a;padding:14px;border-radius:14px;margin:18px 0}.muted{font-size:13px;color:#718096}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;border:0;border-radius:12px;background:#f8fafc;color:#090d14;font-weight:800;text-align:center;text-decoration:none;cursor:pointer}.button.secondary{background:#1e293b;color:#f8fafc;border:1px solid #334155}.button.danger{background:transparent;color:#fca5a5;border:1px solid #7f1d1d}input{width:100%;padding:13px 14px;border-radius:12px;border:1px solid #3b475d;background:#090d14;color:#f8fafc;margin:8px 0 14px}.error{color:#fca5a5}.links code{display:block;padding:11px 12px;background:#090d14;border:1px solid #273449;border-radius:11px;color:#dbeafe;word-break:break-all;margin-top:8px}@media(max-width:720px){.grid{grid-template-columns:1fr}.shell{padding:18px 0}.card{padding:19px}.actions .button,.actions button{width:100%}}
  </style></head><body><main class="shell"><div class="brand"><div class="logo">DM</div><div><strong>${escapeHtml(BUSINESS_NAME)} — WhatsApp</strong><small>Sessão principal compartilhada</small></div></div>${content}</main></body></html>`;
}

function loginPage(error = false) {
  return layout(
    'Acesso ao WhatsApp Web',
    `<section class="card login"><h1>Acessar WhatsApp Web</h1><p>Abra a mesma sessão do Chrome utilizada pelo sistema de atendimento.</p><form method="POST" action="/login"><label for="password">Senha de acesso</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus>${error ? '<p class="error">Senha inválida.</p>' : ''}<button type="submit">Entrar na sessão</button></form><p class="muted">Este acesso permite visualizar, responder, conectar e desconectar o WhatsApp Web.</p></section>`,
  );
}

function localIpv4Addresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces() || {})) {
    for (const item of entries || []) {
      if (item?.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  return [...new Set(addresses)];
}

function accessUrls() {
  const values = [];
  if (PUBLIC_URL) values.push(PUBLIC_URL);
  if (ACCESS_HOST === '0.0.0.0' || ACCESS_HOST === '::') {
    for (const address of localIpv4Addresses()) values.push(`http://${address}:${ACCESS_PORT}`);
    values.push(`http://localhost:${ACCESS_PORT}`);
  } else {
    values.push(`http://${ACCESS_HOST}:${ACCESS_PORT}`);
  }
  return [...new Set(values)];
}

function dashboardPage(vncAvailable, detail = '') {
  const urls = accessUrls();
  return layout(
    'Central do WhatsApp Web',
    `<div class="grid"><section class="card"><h1>Central do WhatsApp Web</h1><p>Este link abre exatamente a mesma tela usada pelo WPPConnect. Quando o WhatsApp já estiver conectado, o vendedor verá as conversas. Quando estiver desconectado, poderá ler o QR Code e conectar novamente.</p><div class="warning"><strong>Atenção:</strong> esta é a sessão principal. Desconectar, trocar de conta, fechar o Chrome ou alterar configurações pode interromper o bot para todos os clientes.</div><div class="actions"><a class="button" href="/viewer">Abrir WhatsApp Web</a><a class="button secondary" href="/status">Atualizar status</a><a class="button danger" href="/logout">Sair deste acesso</a></div></section><aside class="card"><h2>Status da tela compartilhada</h2><div class="status"><span class="dot ${vncAvailable ? 'ok' : 'bad'}"></span><div><strong>${vncAvailable ? 'Tela disponível' : 'Tela indisponível'}</strong><p class="muted">${vncAvailable ? 'O acesso remoto está pronto.' : escapeHtml(detail || 'O servidor VNC ainda não respondeu.')}</p></div></div><div class="links"><h2 style="margin-top:20px">Endereço de acesso</h2>${urls.map((url) => `<code>${escapeHtml(url)}</code>`).join('')}</div><p class="muted">Na VPS, este mesmo portal ficará atrás de HTTPS em um domínio próprio.</p></aside></div>`,
  );
}

function unavailablePage(error) {
  return layout(
    'Tela do WhatsApp indisponível',
    `<section class="card login"><h1>O portal está ativo</h1><p class="error">A tela compartilhada ainda não está disponível.</p><p>Inicie o TightVNC Server ou UltraVNC Server em <strong>${escapeHtml(`${VNC_HOST}:${VNC_PORT}`)}</strong> e tente novamente.</p><p class="muted">Detalhe: ${escapeHtml(error?.message || error || 'conexão recusada')}</p><div class="actions"><a class="button" href="/viewer">Tentar novamente</a><a class="button secondary" href="/">Voltar ao painel</a></div></section>`,
  );
}

function viewerRedirectPage() {
  const url = `/novnc/vnc.html?autoconnect=1&resize=remote&show_dot=1&path=websockify&password=${encodeURIComponent(VNC_PASSWORD)}`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${url}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Abrindo WhatsApp Web</title></head><body><a href="${url}">Abrir WhatsApp Web</a></body></html>`;
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

async function vncStatus() {
  try {
    await ensureVncAvailable(700);
    return { available: true, error: null };
  } catch (error) {
    return { available: false, error: String(error?.message || error) };
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${ACCESS_HOST}:${ACCESS_PORT}`}`);
  const { pathname } = requestUrl;

  if (pathname === '/favicon.ico') return send(req, res, 204, '', 'text/plain');
  if (pathname === '/health') {
    const status = await vncStatus();
    return send(req, res, 200, JSON.stringify({
      ok: true,
      authenticated: isAuthenticated(req),
      vncAvailable: status.available,
      vncError: status.error,
      vncHost: VNC_HOST,
      vncPort: VNC_PORT,
      accessHost: ACCESS_HOST,
      accessPort: ACCESS_PORT,
      accessUrls: accessUrls(),
    }), 'application/json; charset=utf-8');
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
  if (pathname === '/' && !isAuthenticated(req)) return send(req, res, 200, loginPage(false));
  if (!isAuthenticated(req)) {
    res.writeHead(302, { Location: '/', ...securityHeaders(req) });
    return res.end();
  }
  if (pathname === '/' || pathname === '/status') {
    const status = await vncStatus();
    return send(req, res, 200, dashboardPage(status.available, status.error));
  }
  if (pathname === '/viewer') {
    try {
      await ensureVncAvailable();
      return send(req, res, 200, viewerRedirectPage());
    } catch (err) {
      return send(req, res, 503, unavailablePage(err));
    }
  }
  if (pathname.startsWith('/novnc/')) {
    const filePath = resolveNoVncPath(pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return send(req, res, 404, 'Not Found', 'text/plain; charset=utf-8');
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      ...securityHeaders(req),
    });
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

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.log(`[session-access] o portal já está ativo na porta ${ACCESS_PORT}`);
    process.exitCode = 0;
    return;
  }
  console.error('[session-access] erro no portal:', err?.message || err);
  process.exitCode = 1;
});

server.listen(ACCESS_PORT, ACCESS_HOST, async () => {
  console.log('');
  console.log('[session-access] portal do WhatsApp Web iniciado');
  for (const url of accessUrls()) console.log(`[session-access] link: ${url}`);
  console.log(`[session-access] senha configurada: ${ACCESS_PASSWORD ? 'sim' : 'não'}`);
  try {
    await ensureVncAvailable();
    console.log(`[session-access] tela VNC conectada em ${VNC_HOST}:${VNC_PORT}`);
  } catch (err) {
    console.warn(`[session-access] portal ativo, mas a tela VNC ainda não está disponível em ${VNC_HOST}:${VNC_PORT}`);
    console.warn('[session-access] inicie o TightVNC Server ou UltraVNC Server e atualize o painel.');
    console.warn(`[session-access] detalhe: ${err?.message || err}`);
  }
  console.log('');
});
