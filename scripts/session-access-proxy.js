'use strict';

require('dotenv').config();

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

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

function now() {
  return Date.now();
}

function cleanExpiredTokens() {
  const current = now();
  for (const [token, expiresAt] of activeTokens.entries()) {
    if (expiresAt <= current) activeTokens.delete(token);
  }
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const output = {};
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    const key = String(rawKey || '').trim();
    if (!key) continue;
    output[key] = decodeURIComponent(rest.join('=').trim());
  }
  return output;
}

function isAuthenticated(req) {
  cleanExpiredTokens();
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt || expiresAt <= now()) {
    activeTokens.delete(token);
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

function clearSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) activeTokens.delete(token);
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function send(res, statusCode, body, contentType = 'text/html; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function loginPage({ error = '' } = {}) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Acesso à sessão do WhatsApp</title>
  <style>
    body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
    .card { width:min(92vw, 420px); background:#111827; border:1px solid #334155; border-radius:16px; padding:24px; box-shadow:0 20px 40px rgba(0,0,0,.35); }
    h1 { margin:0 0 10px; font-size:22px; }
    p { color:#94a3b8; line-height:1.5; }
    input { width:100%; box-sizing:border-box; padding:12px 14px; border-radius:10px; border:1px solid #475569; background:#0f172a; color:#e2e8f0; margin:10px 0 14px; }
    button { width:100%; padding:12px 14px; border:none; border-radius:10px; background:#2563eb; color:white; font-weight:700; cursor:pointer; }
    .error { color:#fca5a5; min-height:22px; }
    .hint { font-size:13px; color:#64748b; margin-top:12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sessão do WhatsApp Web</h1>
    <p>Digite a senha para abrir a mesma sessão do Chrome usada pelo sistema.</p>
    <form method="POST" action="/login">
      <label for="password">Senha</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
      <div class="error">${error ? 'Senha inválida.' : ''}</div>
      <button type="submit">Entrar</button>
    </form>
    <div class="hint">Acesso local protegido. Feche a aba ou use /logout ao terminar.</div>
  </div>
</body>
</html>`;
}

function viewerPage() {
  const url = `/novnc/vnc.html?autoconnect=1&resize=remote&show_dot=1&path=websockify&password=${encodeURIComponent(VNC_PASSWORD)}`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0; url=${url}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Abrindo sessão do WhatsApp</title>
  <style>body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}a{color:#60a5fa}</style>
</head>
<body>
  <div>
    <p>Abrindo a sessão do WhatsApp Web...</p>
    <p><a href="${url}">Clique aqui se a página não redirecionar.</a></p>
  </div>
</body>
</html>`;
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
    '.html': 'text/html; charset=utf-8',
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
    '.map': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

function resolveNoVncPath(pathname) {
  const relative = pathname.replace(/^\/novnc\/?/, '');
  const resolved = path.resolve(NOVNC_ROOT, relative || 'vnc.html');
  if (!resolved.startsWith(NOVNC_ROOT)) return null;
  return resolved;
}

async function ensureVncAvailable() {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('VNC_TIMEOUT'));
    }, 2000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
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

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true, vncHost: VNC_HOST, vncPort: VNC_PORT, accessPort: ACCESS_PORT }), 'application/json; charset=utf-8');
    return;
  }

  if (pathname === '/logout') {
    clearSession(req);
    clearCookie(res);
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  if (pathname === '/login' && req.method === 'POST') {
    try {
      const rawBody = await readBody(req);
      const form = new URLSearchParams(rawBody);
      const password = String(form.get('password') || '');
      if (password !== ACCESS_PASSWORD) {
        send(res, 401, loginPage({ error: 'invalid' }));
        return;
      }
      const token = issueSession();
      setCookie(res, token);
      res.writeHead(302, { Location: '/viewer' });
      res.end();
      return;
    } catch (_) {
      send(res, 400, loginPage({ error: 'invalid' }));
      return;
    }
  }

  if (pathname === '/' && !isAuthenticated(req)) {
    send(res, 200, loginPage());
    return;
  }

  if (!isAuthenticated(req)) {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  if (pathname === '/' || pathname === '/viewer') {
    send(res, 200, viewerPage());
    return;
  }

  if (pathname.startsWith('/novnc/')) {
    const filePath = resolveNoVncPath(pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  const socket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });

  socket.on('data', (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  });

  socket.on('error', () => {
    try { ws.close(); } catch (_) {}
  });

  socket.on('close', () => {
    try { ws.close(); } catch (_) {}
  });

  ws.on('message', (data) => {
    socket.write(data);
  });

  ws.on('close', () => {
    socket.destroy();
  });

  ws.on('error', () => {
    socket.destroy();
  });
});

server.on('upgrade', (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${ACCESS_HOST}:${ACCESS_PORT}`}`);
  if (requestUrl.pathname !== '/websockify' || !isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

ensureVncAvailable()
  .then(() => {
    server.listen(ACCESS_PORT, ACCESS_HOST, () => {
      console.log('');
      console.log('[session-access] acesso local pronto');
      console.log(`[session-access] link: http://${ACCESS_HOST}:${ACCESS_PORT}`);
      console.log(`[session-access] senha: ${ACCESS_PASSWORD}`);
      console.log(`[session-access] VNC local: ${VNC_HOST}:${VNC_PORT}`);
      console.log('');
      console.log('[session-access] se a tela nao abrir, confira se o TightVNC/UltraVNC Server esta ativo na mesma maquina.');
    });
  })
  .catch((err) => {
    console.error('');
    console.error('[session-access] nao foi possivel conectar ao servidor VNC do Windows.');
    console.error(`[session-access] esperado em ${VNC_HOST}:${VNC_PORT}`);
    console.error('[session-access] instale e ligue o TightVNC Server ou UltraVNC Server, usando a senha 2580.');
    console.error(`[session-access] detalhe: ${err?.message || err}`);
    process.exitCode = 1;
  });
