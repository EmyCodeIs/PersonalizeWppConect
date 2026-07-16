'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const accessHost = String(process.env.SESSION_ACCESS_HOST || '127.0.0.1').trim();
const accessPort = Math.max(1, numberEnv('SESSION_ACCESS_PORT', 6080));
const accessPassword = String(process.env.SESSION_ACCESS_PASSWORD || '').trim();
const vncHost = String(process.env.SESSION_VNC_HOST || '127.0.0.1').trim();
const vncPort = Math.max(1, numberEnv('SESSION_VNC_PORT', 5900));
const vncPassword = String(process.env.SESSION_VNC_PASSWORD || '').trim();
const disableAppLogin = /^(1|true|yes|sim|on)$/i.test(String(process.env.SESSION_ACCESS_DISABLE_APP_LOGIN || '').trim());
const novncRoot = path.resolve(process.cwd(), 'node_modules', '@novnc', 'novnc');
const rfbModule = path.join(novncRoot, 'core', 'rfb.js');

if (!disableAppLogin && !accessPassword) {
  throw new Error('Defina SESSION_ACCESS_PASSWORD no .env.');
}
if (!vncPassword) {
  throw new Error('Defina SESSION_VNC_PASSWORD no .env.');
}
if (!fs.existsSync(rfbModule)) {
  throw new Error('noVNC não encontrado. Execute npm install antes de iniciar.');
}

const authSecret = crypto.randomBytes(32);
const expectedToken = crypto.createHmac('sha256', authSecret).update('authorized').digest('hex');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(request) {
  const output = {};
  for (const item of String(request.headers.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) output[key] = value;
  }
  return output;
}

function isAuthorized(request) {
  if (disableAppLogin) return true;
  const token = parseCookies(request).personalize_session_access || '';
  const received = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function send(response, statusCode, contentType, body, extraHeaders = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  response.end(content);
}

function loginPage(error = '') {
  const warning = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Acesso ao WhatsApp</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#f5f5f5;font-family:Arial,sans-serif;padding:24px}
    main{width:min(420px,100%);background:#1c1c1c;border:1px solid #333;border-radius:18px;padding:28px;box-shadow:0 20px 60px #0008}
    h1{font-size:22px;margin:0 0 8px}p{color:#bbb;line-height:1.45}.error{color:#ff9b9b}
    label{display:block;margin:22px 0 8px;font-weight:700}input{width:100%;padding:14px;border-radius:10px;border:1px solid #444;background:#111;color:#fff;font-size:16px}
    button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:10px;background:#f1f1f1;color:#111;font-weight:800;font-size:16px;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>WhatsApp da Personalize</h1>
    <p>Entre para controlar o mesmo computador onde o WPPConnect está aberto.</p>
    ${warning}
    <form method="post" action="/login">
      <label for="password">Senha de acesso</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`;
}

function viewerPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp da Personalize</title>
  <style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#111;font-family:Arial,sans-serif}
    #screen{width:100%;height:100%}#status{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10;background:#111d;color:#fff;padding:8px 12px;border-radius:999px;font-size:13px;box-shadow:0 4px 18px #0008}
  </style>
</head>
<body>
  <div id="status">Conectando ao computador...</div>
  <div id="screen"></div>
  <script type="module">
    import RFB from '/novnc/core/rfb.js';

    const status = document.getElementById('status');
    const screen = document.getElementById('screen');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const rfb = new RFB(screen, protocol + '//' + location.host + '/websockify', {
      credentials: { password: ${JSON.stringify(vncPassword)} }
    });

    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.viewOnly = false;
    rfb.focusOnClick = true;

    rfb.addEventListener('connect', () => {
      status.textContent = 'Conectado';
      setTimeout(() => { status.style.display = 'none'; }, 1200);
    });
    rfb.addEventListener('credentialsrequired', () => {
      rfb.sendCredentials({ password: ${JSON.stringify(vncPassword)} });
    });
    rfb.addEventListener('disconnect', (event) => {
      status.style.display = 'block';
      status.textContent = event.detail.clean ? 'Conexão encerrada.' : 'Conexão perdida. Confira o TightVNC.';
    });
    rfb.addEventListener('securityfailure', (event) => {
      status.style.display = 'block';
      status.textContent = 'Senha VNC recusada: ' + (event.detail.reason || 'verifique a configuração.');
    });
  </script>
</body>
</html>`;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[extension] || 'application/octet-stream';
}

function serveNovnc(requestPath, response) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(requestPath.slice('/novnc/'.length));
  } catch (_) {
    send(response, 400, 'text/plain; charset=utf-8', 'Caminho inválido.');
    return;
  }

  const resolved = path.resolve(novncRoot, relativePath);
  if (resolved !== novncRoot && !resolved.startsWith(`${novncRoot}${path.sep}`)) {
    send(response, 403, 'text/plain; charset=utf-8', 'Acesso negado.');
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error || !data) {
      send(response, 404, 'text/plain; charset=utf-8', 'Arquivo não encontrado.');
      return;
    }
    send(response, 200, contentType(resolved), data);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error('Corpo da requisição muito grande.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, vncHost, vncPort }));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/login') {
    if (disableAppLogin) {
      response.writeHead(302, {
        Location: '/',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    try {
      const form = new URLSearchParams(await readBody(request));
      const supplied = String(form.get('password') || '');
      const suppliedBuffer = Buffer.from(supplied);
      const expectedBuffer = Buffer.from(accessPassword);
      const valid = suppliedBuffer.length === expectedBuffer.length
        && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);

      if (!valid) {
        send(response, 401, 'text/html; charset=utf-8', loginPage('Senha incorreta.'));
        return;
      }

      response.writeHead(302, {
        Location: '/',
        'Set-Cookie': `personalize_session_access=${expectedToken}; Path=/; HttpOnly; SameSite=Strict`,
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    } catch (error) {
      send(response, 400, 'text/html; charset=utf-8', loginPage(error?.message || 'Não foi possível entrar.'));
      return;
    }
  }

  if (request.method === 'GET' && url.pathname === '/logout') {
    if (disableAppLogin) {
      response.writeHead(302, {
        Location: '/',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    response.writeHead(302, {
      Location: '/',
      'Set-Cookie': 'personalize_session_access=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      'Cache-Control': 'no-store',
    });
    response.end();
    return;
  }

  if (!isAuthorized(request)) {
    send(response, 200, 'text/html; charset=utf-8', loginPage());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/') {
    send(response, 200, 'text/html; charset=utf-8', viewerPage(), {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data:",
    });
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/novnc/')) {
    serveNovnc(url.pathname, response);
    return;
  }

  send(response, 404, 'text/plain; charset=utf-8', 'Não encontrado.');
});

const webSocketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  handleProtocols(protocols) {
    return protocols.has('binary') ? 'binary' : false;
  },
});

server.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
  } catch (_) {}

  if (pathname !== '/websockify' || !isAuthorized(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
});

webSocketServer.on('connection', (webSocket) => {
  const vncSocket = net.createConnection({ host: vncHost, port: vncPort });
  vncSocket.setNoDelay(true);

  vncSocket.on('connect', () => {
    console.log(`[session-access] navegador conectado ao VNC ${vncHost}:${vncPort}`);
  });

  vncSocket.on('data', (chunk) => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(chunk, { binary: true });
  });

  vncSocket.on('error', (error) => {
    console.warn(`[session-access] falha na conexão VNC ${vncHost}:${vncPort}:`, error?.message || error);
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, 'VNC indisponível');
  });

  vncSocket.on('close', () => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000, 'VNC encerrado');
  });

  webSocket.on('message', (data) => {
    if (!vncSocket.writable) return;
    if (Buffer.isBuffer(data)) vncSocket.write(data);
    else if (data instanceof ArrayBuffer) vncSocket.write(Buffer.from(data));
    else if (Array.isArray(data)) vncSocket.write(Buffer.concat(data));
    else vncSocket.write(Buffer.from(data));
  });

  webSocket.on('close', () => vncSocket.destroy());
  webSocket.on('error', () => vncSocket.destroy());
});

function networkAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  return [...new Set(addresses)];
}

server.listen(accessPort, accessHost, () => {
  console.log('[session-access] acesso direto iniciado');
  console.log(`[session-access] local: http://localhost:${accessPort}`);
  if (accessHost === '0.0.0.0') {
    for (const address of networkAddresses()) {
      console.log(`[session-access] rede: http://${address}:${accessPort}`);
    }
  }
  console.log(`[session-access] VNC de destino: ${vncHost}:${vncPort}`);
});

function shutdown() {
  for (const client of webSocketServer.clients) {
    try { client.close(1001, 'Sistema encerrado'); } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);