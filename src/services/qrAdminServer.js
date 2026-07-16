'use strict';

const http = require('http');

const host = process.env.QR_ADMIN_HOST || '127.0.0.1';
const port = Number(process.env.QR_ADMIN_PORT || 3210);

let clientRef = null;
let started = false;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function setQrAdminClient(client) {
  clientRef = client || null;
}

function startQrAdminServer() {
  if (started) return;

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, connected: !!clientRef });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      try {
        await readBody(request);
        if (!clientRef || typeof clientRef.logout !== 'function') {
          sendJson(response, 503, { ok: false, error: 'client_unavailable' });
          return;
        }

        const result = await clientRef.logout();
        sendJson(response, 200, { ok: result !== false });
      } catch (error) {
        const message = String(error?.message || error || 'logout_failed');
        if (/Execution context was destroyed/i.test(message)) {
          sendJson(response, 200, { ok: true, warning: 'context_destroyed_after_logout' });
          return;
        }
        sendJson(response, 500, {
          ok: false,
          error: message,
        });
      }
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not_found' });
  });

  server.listen(port, host, () => {
    console.log(`[QR ADMIN] ouvindo em http://${host}:${port}`);
  });

  started = true;
}

module.exports = {
  setQrAdminClient,
  startQrAdminServer,
};
