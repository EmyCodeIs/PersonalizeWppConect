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

const ACCESS_HOST = process.env.SESSION_ACCESS_HOST || '127.0.0.1';
const ACCESS_PORT = Number(process.env.SESSION_ACCESS_PORT || 6080);
const ACCESS_PASSWORD = process.env.SESSION_ACCESS_PASSWORD || '2580';
const VNC_HOST = process.env.SESSION_VNC_HOST || '127.0.0.1';
const VNC_PORT = Number(process.env.SESSION_VNC_PORT || 5900);
const VNC_PASSWORD = process.env.SESSION_VNC_PASSWORD || ACCESS_PASSWORD;
const COOKIE_NAME = 'personalize_session_access';
const NOVNC_ROOT = path.resolve(__dirname, '..', 'node_modules', '@novnc', 'novnc');
const sessions = new Map();

if (!fs.existsSync(path.join(NOVNC_ROOT, 'core', 'rfb.js'))) {
  console.error(`[session-access] noVNC não encontrado em ${NOVNC_ROOT}`);
  console.error('[session-access] execute npm install.');
  process.exit(1);
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.split('=');
    if (key?.trim()) result[key.trim()] = decodeURIComponent(rest.join('=').trim());
  }
  return result;
}

function authenticated(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return Boolean(token && sessions.has(token));
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function loginPage(error = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Web</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f14;color:#fff;font-family:Arial}.box{width:min(90vw,420px);padding:24px;background:#111827;border:1px solid #334155;border-radius:16px}input,button{width:100%;box-sizing:border-box;padding:13px;border-radius:10px}input{margin:12px 0;border:1px solid #475569;background:#0f172a;color:#fff}button{border:0;font-weight:700}.err{color:#fca5a5}</style></head><body><form class="box" method="POST" action="/login"><h1>WhatsApp Web</h1><p>Acesse a mesma tela usada pela automação.</p><input type="password" name="password" placeholder="Senha" autofocus>${error ? '<p class="err">Senha inválida.</p>' : ''}<button type="submit">Abrir</button></form></body></html>`;
}

function unavailablePage(error) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tela indisponível</title></head><body style="font-family:Arial;background:#0b0f14;color:#fff;padding:32px"><h1>Acesso ativo, mas sem tela compartilhada</h1><p>Nenhum servidor VNC respondeu em ${VNC_HOST}:${VNC_PORT}.</p><p>${String(error?.message || error || '')}</p></body></html>`;
}

function viewerPage() {
  const password = JSON.stringify(VNC_PASSWORD);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>WhatsApp Web</title><style>html,body,#screen{width:100%;height:100%;margin:0;overflow:hidden;background:#111}#status{position:fixed;z-index:10;top:10px;left:10px;background:#0f172ae8;color:#fff;padding:8px 10px;border-radius:8px;font:13px Arial}</style></head><body><div id="status">Conectando...</div><div id="screen"></div><script type="module">import RFB from '/novnc/core/rfb.js';const status=document.getElementById('status');const protocol=location.protocol==='https:'?'wss':'ws';const rfb=new RFB(document.getElementById('screen'),protocol+'://'+location.host+'/websockify',{credentials:{password:${password}}});rfb.scaleViewport=true;rfb.viewOnly=false;rfb.showDotCursor=true;rfb.addEventListener('connect',()=>{status.textContent='Conectado';setTimeout(()=>status.style.display='none',1200)});rfb.addEventListener('disconnect',event=>{status.style.display='block';status.textContent=event.detail.clean?'Sessão encerrada':'Conexão perdida'});rfb.addEventListener('credentialsrequired',()=>rfb.sendCredentials({password:${password}}));rfb.addEventListener('securityfailure',event=>{status.style.display='block';status.textContent='Falha de autenticação VNC: '+(event.detail?.reason||'senha ou configuração inválida')});</script></body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) reject(new Error('too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function vncAvailable(timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('VNC_TIMEOUT'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
    socket.once('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function probeVnc(timeoutMs = 1800) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - startedAt });
    };
    const timeout = setTimeout(() => finish({ available: false, banner: null, error: 'VNC_TIMEOUT' }), timeoutMs);
    socket.once('data', chunk => finish({ available: true, banner: chunk.toString('ascii').trim(), error: null }));
    socket.once('connect', () => setTimeout(() => finish({ available: true, banner: null, error: null }), 500));
    socket.once('error', error => finish({ available: false, banner: null, error: String(error?.message || error) }));
  });
}

function noVncFile(urlPath) {
  const relative = urlPath.replace(/^\/novnc\/?/, '');
  const resolved = path.resolve(NOVNC_ROOT, relative);
  return resolved.startsWith(NOVNC_ROOT) ? resolved : null;
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

  if (pathname === '/health') {
    const probe = await probeVnc();
    return send(res, 200, JSON.stringify({
      ok: true,
      accessHost: ACCESS_HOST,
      accessPort: ACCESS_PORT,
      vncHost: VNC_HOST,
      vncPort: VNC_PORT,
      vncAvailable: probe.available,
      vncBanner: probe.banner,
      vncError: probe.error,
      latencyMs: probe.latencyMs,
    }, null, 2), 'application/json; charset=utf-8');
  }

  if (pathname === '/login' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    if (String(form.get('password') || '') !== ACCESS_PASSWORD) return send(res, 401, loginPage(true));
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, Date.now());
    res.writeHead(302, { Location: '/', 'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/` });
    return res.end();
  }

  if (!authenticated(req)) return send(res, 200, loginPage(false));

  if (pathname === '/' || pathname === '/viewer') {
    try {
      await vncAvailable();
      return send(res, 200, viewerPage());
    } catch (error) {
      return send(res, 503, unavailablePage(error));
    }
  }

  if (pathname.startsWith('/novnc/')) {
    const file = noVncFile(pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  return send(res, 404, 'Not found', 'text/plain');
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', ws => {
  const socket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });
  socket.on('data', chunk => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
  });
  socket.on('error', error => {
    console.warn(`[session-access] conexão VNC encerrada: ${error?.message || error}`);
    try { ws.close(); } catch (_) {}
  });
  socket.on('close', () => {
    try { ws.close(); } catch (_) {}
  });
  ws.on('message', data => socket.write(Buffer.isBuffer(data) ? data : Buffer.from(data)));
  ws.on('close', () => socket.destroy());
  ws.on('error', () => socket.destroy());
});

server.on('upgrade', async (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/websockify' || !authenticated(req)) return socket.destroy();
  try {
    await vncAvailable(900);
  } catch (_) {
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

server.on('error', error => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[session-access] porta ${ACCESS_PORT} já está em uso por outro processo.`);
    return;
  }
  console.error('[session-access] erro:', error?.stack || error?.message || error);
});

server.listen(ACCESS_PORT, ACCESS_HOST, async () => {
  console.log('');
  console.log('[session-access] acesso direto iniciado');
  console.log(`[session-access] local: http://localhost:${ACCESS_PORT}`);
  if (ACCESS_HOST === '0.0.0.0') {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const item of entries || []) {
        if (item.family === 'IPv4' && !item.internal) console.log(`[session-access] rede: http://${item.address}:${ACCESS_PORT}`);
      }
    }
  }
  const probe = await probeVnc();
  if (probe.available) console.log(`[session-access] VNC respondeu em ${VNC_HOST}:${VNC_PORT} | protocolo=${probe.banner || 'conectado sem banner'}`);
  else console.warn(`[session-access] portal ativo, mas sem VNC em ${VNC_HOST}:${VNC_PORT} | ${probe.error}`);
  console.log('');
});
