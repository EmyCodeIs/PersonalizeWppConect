'use strict';

const fs = require('fs');
const path = require('path');

const QR_DIR = path.resolve(process.cwd(), 'data', 'qr-status');
const HTML_PATH = path.join(QR_DIR, 'index.html');
const JSON_PATH = path.join(QR_DIR, 'status.json');
const SCREENSHOT_PATH = path.join(QR_DIR, 'whatsapp-page.png');
const PUBLIC_HTML_PATH = String(process.env.QR_STATUS_PUBLIC_HTML || '').trim();

function ensureDir() {
  fs.mkdirSync(QR_DIR, { recursive: true });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeState(value) {
  return String(value || '').trim().toUpperCase();
}

function isConnectedState(value) {
  const normalized = normalizeState(value);
  return [
    'CONNECTED',
    'SYNCING',
    'RESUMING',
    'INCHAT',
    'MAIN',
    'NORMAL',
  ].some((item) => normalized.includes(item));
}

function extractPairingCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const compact = raw.replace(/\s+/g, '');
  if (/^[A-Z0-9-]{6,12}$/i.test(compact) && !/^https?:\/\//i.test(compact)) {
    return compact.toUpperCase();
  }

  return '';
}

function formatDate(value) {
  if (!value) return 'Ainda não registrada';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  }).format(parsed);
}

function readSnapshot() {
  try {
    if (!fs.existsSync(JSON_PATH)) return {};
    return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function deriveHealth(snapshot) {
  const status = String(snapshot.status || '').toLowerCase();
  const connectionState = String(snapshot.connectionState || '').toUpperCase();

  if (status === 'connected') {
    return {
      tone: 'stable',
      label: 'Estável',
      description: 'Sessão conectada e pronta para uso.',
    };
  }

  if (['CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE', 'DISCONNECTEDMOBILE', 'DISCONNECTED'].includes(connectionState)) {
    return {
      tone: 'conflict',
      label: 'Em conflito',
      description: 'A sessão precisa ser reconectada para voltar ao estado normal.',
    };
  }

  if (status === 'qr' || ['PAIRING', 'OPENING', 'UNLAUNCHED'].includes(connectionState)) {
    return {
      tone: 'reconnect',
      label: 'Reconectando',
      description: 'Leia o QR Code ou use o código abaixo para conectar novamente.',
    };
  }

  return {
    tone: 'waiting',
    label: 'Aguardando',
    description: snapshot.message || 'Aguardando atualização do WhatsApp.',
  };
}

function mergeSnapshot(snapshot) {
  const previous = readSnapshot();
  const next = {
    ...previous,
    ...snapshot,
    updatedAt: snapshot.updatedAt || nowIso(),
  };

  if (snapshot.status === 'connected') {
    next.lastConnectedAt = snapshot.lastConnectedAt || next.updatedAt;
  } else if (!next.lastConnectedAt && previous.lastConnectedAt) {
    next.lastConnectedAt = previous.lastConnectedAt;
  }

  if (!next.connectionState) {
    next.connectionState = previous.connectionState || '';
  }

  return next;
}

function writeSnapshot(snapshot) {
  ensureDir();
  const merged = mergeSnapshot(snapshot);
  const html = renderHtml(merged);
  fs.writeFileSync(JSON_PATH, JSON.stringify(merged, null, 2));
  fs.writeFileSync(HTML_PATH, html);
  if (PUBLIC_HTML_PATH) {
    fs.mkdirSync(path.dirname(PUBLIC_HTML_PATH), { recursive: true });
    fs.writeFileSync(PUBLIC_HTML_PATH, html);
  }
}

function renderQrCard(snapshot) {
  if (snapshot.status !== 'qr' || !snapshot.imageSrc) return '';
  const attempts = Number(snapshot.attempts || 0);
  return `
    <section class="panel qr-panel">
      <div class="panel-copy">
        <span class="eyebrow">Conectar pelo celular</span>
        <h2>Leia o QR Code do WhatsApp</h2>
        <p>Abra o WhatsApp Business do número da operação, vá em aparelhos conectados e faça a leitura.</p>
        <ul class="steps">
          <li>WhatsApp Business</li>
          <li>Aparelhos conectados</li>
          <li>Conectar um aparelho</li>
        </ul>
        <p class="muted">Tentativa atual: ${escapeHtml(attempts || 1)}</p>
      </div>
      <div class="qr-shell">
        <img src="${escapeHtml(snapshot.imageSrc)}" alt="QR Code do WhatsApp">
      </div>
    </section>
  `;
}

function renderCodeCard(snapshot) {
  const code = String(snapshot.urlCode || '').trim();
  return `
    <section class="panel code-panel">
      <div class="panel-copy">
        <span class="eyebrow">Conectar com código</span>
        <h2>Código de vínculo</h2>
        <p>${code ? 'Se o seu WhatsApp oferecer pareamento por código, use este código no celular.' : 'O código aparecerá aqui quando o WhatsApp liberar essa forma de conexão.'}</p>
      </div>
      <div class="code-box ${code ? '' : 'is-empty'}">
        ${code ? escapeHtml(code) : 'Aguardando código'}
      </div>
    </section>
  `;
}

function renderStatusGrid(snapshot) {
  const health = deriveHealth(snapshot);
  const currentState = escapeHtml(snapshot.connectionState || 'SEM SINAL');
  return `
    <section class="status-grid">
      <article class="status-card">
        <span class="eyebrow">Status da sessão</span>
        <div class="status-pill is-${health.tone}">${escapeHtml(health.label)}</div>
        <p>${escapeHtml(health.description)}</p>
      </article>
      <article class="status-card">
        <span class="eyebrow">Última conexão estável</span>
        <strong>${escapeHtml(formatDate(snapshot.lastConnectedAt))}</strong>
        <p>Registrada quando o WhatsApp entrou em modo conectado.</p>
      </article>
      <article class="status-card">
        <span class="eyebrow">Estado técnico</span>
        <strong>${currentState}</strong>
        <p>Atualizado em ${escapeHtml(formatDate(snapshot.updatedAt))}.</p>
      </article>
    </section>
  `;
}

function renderFallback(snapshot) {
  if (snapshot.status === 'qr') return '';
  const health = deriveHealth(snapshot);
  return `
    <section class="panel fallback-panel">
      <span class="eyebrow">Painel de conexão</span>
      <h2>${escapeHtml(health.label)}</h2>
      <p>${escapeHtml(health.description)}</p>
    </section>
  `;
}

function renderHtml(snapshot) {
  const health = deriveHealth(snapshot);
  const title = snapshot.status === 'connected'
    ? 'WhatsApp da Personalize conectado'
    : 'Conexão do WhatsApp da Personalize';
  const qrActive = snapshot.status === 'qr' && snapshot.imageSrc;
  const pairingCode = extractPairingCode(snapshot.pairingCode || snapshot.urlCode);
  const codeActive = pairingCode;
  const initialTab = qrActive ? 'qr' : 'code';

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="8">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #050505;
      --bg-soft: #0f0f10;
      --panel: #101011;
      --panel-soft: #151517;
      --ink: #f6f3ee;
      --muted: #b8b1a5;
      --line: rgba(255, 255, 255, 0.1);
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      --accent: #f9a62c;
      --accent-strong: #ffb84d;
      --green: #35c46f;
      --green-deep: #d9ffe8;
      --amber: #f2b743;
      --red: #ef6d5a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, rgba(249,166,44,.18), transparent 18%),
        radial-gradient(circle at left center, rgba(255,255,255,.08), transparent 20%),
        linear-gradient(180deg, #020202 0%, #090909 100%);
      min-height: 100vh;
    }
    .wrap {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }
    .hero {
      display: grid;
      gap: 20px;
      padding: 30px 32px 36px;
      border-radius: 36px;
      background: linear-gradient(180deg, rgba(16,16,17,.96), rgba(8,8,9,.98));
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      width: fit-content;
    }
    .brand-mark {
      width: 18px;
      height: 18px;
      background: linear-gradient(135deg, #f9a62c, #ff4f4f 52%, #2ab3ff);
      transform: rotate(45deg);
      border-radius: 2px;
      box-shadow: 0 0 24px rgba(249,166,44,.3);
    }
    .brand-text {
      display: grid;
      gap: 2px;
    }
    .brand-text strong {
      font-size: 28px;
      letter-spacing: -.04em;
    }
    .brand-text span {
      font-size: 13px;
      color: var(--muted);
    }
    .eyebrow {
      display: inline-block;
      font-size: 12px;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--muted);
    }
    h1, h2, p { margin: 0; }
    h1 {
      max-width: 11ch;
      font-size: clamp(38px, 6vw, 82px);
      line-height: .98;
      letter-spacing: -.05em;
    }
    .hero p {
      max-width: 54ch;
      color: var(--muted);
      line-height: 1.6;
      font-size: 20px;
    }
    .hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 10px 16px;
      border-radius: 999px;
      font-weight: 700;
      border: 1px solid transparent;
    }
    .is-stable {
      background: rgba(53,196,111,.14);
      color: var(--green-deep);
      border-color: rgba(53,196,111,.28);
    }
    .is-reconnect, .is-waiting {
      background: rgba(242,183,67,.12);
      color: #ffd98f;
      border-color: rgba(242,183,67,.26);
    }
    .is-conflict {
      background: rgba(239,109,90,.12);
      color: #ffc4bc;
      border-color: rgba(239,109,90,.24);
    }
    .content {
      display: grid;
      gap: 24px;
      margin-top: 24px;
    }
    .panel, .status-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 32px;
      box-shadow: var(--shadow);
    }
    .connection-panel {
      display: grid;
      gap: 20px;
      padding: 26px;
    }
    .connection-top {
      display: grid;
      gap: 14px;
    }
    .tabs {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .tab {
      border: 1px solid var(--line);
      background: transparent;
      color: var(--muted);
      padding: 12px 16px;
      border-radius: 999px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .tab[aria-selected="true"] {
      background: rgba(249,166,44,.14);
      color: #fff4de;
      border-color: rgba(249,166,44,.32);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
    }
    .action-btn {
      appearance: none;
      border: 0;
      border-radius: 16px;
      min-height: 52px;
      padding: 0 20px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      transition: transform .15s ease, opacity .15s ease, background .15s ease;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .action-btn:hover { transform: translateY(-1px); }
    .action-primary {
      background: linear-gradient(180deg, var(--accent-strong), var(--accent));
      color: #1f1305;
    }
    .action-secondary {
      background: rgba(255,255,255,.05);
      color: var(--ink);
      border: 1px solid var(--line);
    }
    .action-danger {
      background: rgba(239,109,90,.14);
      color: #ffd7d1;
      border: 1px solid rgba(239,109,90,.22);
    }
    .panel-copy {
      display: grid;
      gap: 10px;
    }
    .panel-copy h2 {
      font-size: clamp(24px, 3vw, 38px);
      line-height: 1.02;
    }
    .panel-copy p {
      color: var(--muted);
      line-height: 1.6;
    }
    .tab-content {
      display: none;
    }
    .tab-content.is-active {
      display: grid;
      gap: 22px;
      grid-template-columns: minmax(0, 1.05fr) minmax(300px, .95fr);
      align-items: stretch;
    }
    .steps {
      margin: 0;
      padding-left: 20px;
      color: var(--ink);
      line-height: 1.8;
    }
    .muted {
      color: var(--muted);
      font-size: 14px;
    }
    .qr-shell {
      display: grid;
      place-items: center;
      min-height: 390px;
      border-radius: 26px;
      padding: 18px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02)),
        var(--panel-soft);
      border: 1px solid var(--line);
    }
    .qr-shell img {
      display: block;
      width: min(100%, 340px);
      background: white;
      border-radius: 18px;
      padding: 16px;
      box-shadow: 0 10px 30px rgba(40, 29, 17, 0.12);
    }
    .code-box {
      display: grid;
      place-items: center;
      min-height: 240px;
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
      color: #f8f1e5;
      border: 1px solid var(--line);
      padding: 20px;
      font-size: clamp(28px, 5vw, 46px);
      font-weight: 700;
      letter-spacing: .12em;
      text-align: center;
      word-break: break-word;
    }
    .code-box.is-empty {
      font-size: 20px;
      letter-spacing: 0;
      color: #d4c3af;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 20px;
    }
    .status-card {
      padding: 22px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .status-card strong {
      font-size: 22px;
    }
    .status-card p {
      color: var(--muted);
      line-height: 1.55;
    }
    .feedback {
      min-height: 24px;
      color: var(--muted);
      font-size: 14px;
    }
    .feedback.is-success { color: #bff6d2; }
    .feedback.is-error { color: #ffbeb4; }
    @media (max-width: 900px) {
      .status-grid, .tab-content.is-active {
        grid-template-columns: 1fr;
      }
      .wrap {
        width: min(100% - 24px, 1180px);
      }
      .hero, .connection-panel, .status-card {
        border-radius: 24px;
      }
      .hero p { font-size: 17px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-text">
          <strong>Personalize</strong>
          <span>Seu ambiente</span>
        </span>
      </div>
      <span class="eyebrow">Conexão protegida do WhatsApp</span>
      <h1>Conecte ou recupere a sessão do WhatsApp</h1>
      <p>Acompanhe o status da sessão, reconecte por QR Code, use o código quando estiver disponível e force uma desconexão segura quando precisar recomeçar.</p>
      <div class="hero-meta">
        <div class="status-pill is-${escapeHtml(health.tone)}">${escapeHtml(health.label)}</div>
        <span class="muted">Última atualização: ${escapeHtml(formatDate(snapshot.updatedAt))}</span>
      </div>
    </header>

    <main class="content">
      ${renderStatusGrid(snapshot)}
      <section class="panel connection-panel">
        <div class="connection-top">
          <div class="panel-copy">
            <span class="eyebrow">Ações de conexão</span>
            <h2>Escolha como quer reconectar</h2>
            <p>Use a aba de QR quando o WhatsApp pedir leitura no celular. Se o código de pareamento estiver disponível, ele aparece na aba de código.</p>
          </div>
          <div class="tabs" role="tablist" aria-label="Método de conexão">
            <button class="tab" type="button" role="tab" aria-selected="${initialTab === 'qr' ? 'true' : 'false'}" aria-controls="tab-qr" data-tab="qr">QR Code</button>
            <button class="tab" type="button" role="tab" aria-selected="${initialTab === 'code' ? 'true' : 'false'}" aria-controls="tab-code" data-tab="code">Código</button>
          </div>
          <div class="actions">
            <button class="action-btn action-primary" type="button" id="refresh-status">Atualizar status</button>
            <button class="action-btn action-danger" type="button" id="logout-session">Desconectar sessão</button>
            <a class="action-btn action-secondary" href="/" target="_blank" rel="noreferrer">Abrir painel completo</a>
          </div>
          <div class="feedback" id="action-feedback" aria-live="polite"></div>
        </div>

        <section class="tab-content ${initialTab === 'qr' ? 'is-active' : ''}" id="tab-qr" role="tabpanel">
          <div class="panel-copy">
            <span class="eyebrow">Leitura por celular</span>
            <h2>Leia o QR Code com o WhatsApp Business</h2>
            <p>Abra o aplicativo principal do número da operação, entre em aparelhos conectados e leia o QR exibido nesta tela.</p>
            <ul class="steps">
              <li>Abra o WhatsApp Business</li>
              <li>Entre em aparelhos conectados</li>
              <li>Escolha conectar um aparelho</li>
            </ul>
            <p class="muted">Tentativa atual: ${escapeHtml(Number(snapshot.attempts || 0) || 1)}</p>
          </div>
          <div class="qr-shell">
            ${qrActive ? `<img src="${escapeHtml(snapshot.imageSrc)}" alt="QR Code do WhatsApp">` : `<div class="panel-copy"><h2>QR indisponível agora</h2><p>Quando a sessão pedir reconexão, o QR aparecerá aqui automaticamente.</p></div>`}
          </div>
        </section>

        <section class="tab-content ${initialTab === 'code' ? 'is-active' : ''}" id="tab-code" role="tabpanel">
          <div class="panel-copy">
            <span class="eyebrow">Pareamento por código</span>
            <h2>Conecte usando um código</h2>
            <p>Quando o WhatsApp liberar um código curto de pareamento, este painel mostrará o código pronto para ser digitado no celular.</p>
            <ul class="steps">
              <li>Abra a opção de conectar com código no celular</li>
              <li>Digite o código exibido nesta tela</li>
              <li>Confirme o vínculo e aguarde a sincronização</li>
            </ul>
          </div>
          <div class="code-box ${codeActive ? '' : 'is-empty'}">${codeActive ? escapeHtml(pairingCode) : 'Código curto indisponível nesta sessão'}</div>
        </section>
      </section>
    </main>
  </div>
  <script>
    (() => {
      const tabs = [...document.querySelectorAll('[data-tab]')];
      const panels = [...document.querySelectorAll('.tab-content')];
      const feedback = document.getElementById('action-feedback');

      function activate(tabName) {
        tabs.forEach((tab) => {
          const active = tab.dataset.tab === tabName;
          tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        panels.forEach((panel) => {
          panel.classList.toggle('is-active', panel.id === 'tab-' + tabName);
        });
      }

      tabs.forEach((tab) => tab.addEventListener('click', () => activate(tab.dataset.tab)));

      document.getElementById('refresh-status')?.addEventListener('click', () => {
        window.location.reload();
      });

      document.getElementById('logout-session')?.addEventListener('click', async () => {
        feedback.textContent = 'Desconectando sessão...';
        feedback.className = 'feedback';
        try {
          const response = await fetch('/qr-admin/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'logout' }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || 'logout_failed');
          }
          feedback.textContent = 'Sessão desconectada. O novo QR deve aparecer em instantes.';
          feedback.className = 'feedback is-success';
          window.setTimeout(() => window.location.reload(), 1800);
        } catch (error) {
          feedback.textContent = 'Não foi possível desconectar agora. Tente novamente em alguns segundos.';
          feedback.className = 'feedback is-error';
        }
      });
    })();
  </script>
</body>
</html>`;
}

function normalizeDataUrl(base64Qr) {
  const value = String(base64Qr || '').trim();
  if (!value) return '';
  if (value.startsWith('data:image')) return value;
  return `data:image/png;base64,${value}`;
}

function publishQrCode({ base64Qr, attempts = 0, urlCode = '', connectionState = 'PAIRING' } = {}) {
  const imageSrc = normalizeDataUrl(base64Qr);
  if (!imageSrc) return;
  writeSnapshot({
    status: 'qr',
    attempts,
    urlCode,
    imageSrc,
    connectionState,
    updatedAt: nowIso(),
  });
}

function publishConnected(connectionState = 'CONNECTED') {
  const now = nowIso();
  writeSnapshot({
    status: 'connected',
    connectionState,
    lastConnectedAt: now,
    updatedAt: now,
  });
}

function publishMessage(message, connectionState = '') {
  writeSnapshot({
    status: 'waiting',
    message: String(message || 'Aguardando atualizacao do WhatsApp.'),
    connectionState,
    updatedAt: nowIso(),
  });
}

function publishState(connectionState, message = '') {
  const normalized = String(connectionState || '').trim().toUpperCase();
  if (!normalized) {
    publishMessage(message);
    return;
  }

  if (isConnectedState(normalized)) {
    publishConnected(normalized);
    return;
  }

  const waitingMessage = message
    || (
      ['CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE', 'DISCONNECTEDMOBILE', 'DISCONNECTED'].includes(normalized)
        ? 'A sessão está em conflito e precisa ser reconectada.'
        : 'WhatsApp aguardando conexão.'
    );

  publishMessage(waitingMessage, normalized);
}

function publishLivePageScreenshot(imageBuffer, message = '') {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return;
  ensureDir();
  fs.writeFileSync(SCREENSHOT_PATH, imageBuffer);
  const imageSrc = `data:image/png;base64,${imageBuffer.toString('base64')}`;
  writeSnapshot({
    status: 'live-page',
    message: String(message || 'Leitura direta da pagina real do WhatsApp Web.'),
    imageSrc,
    updatedAt: nowIso(),
  });
}

deriveHealth = function deriveHealth(snapshot) {
  const status = String(snapshot.status || '').toLowerCase();
  const connectionState = normalizeState(snapshot.connectionState);
  const disconnectState = normalizeState(snapshot.disconnectState);

  if (status === 'connected') {
    return {
      tone: 'stable',
      label: 'Estável',
      description: 'Sessão conectada e pronta para uso.',
    };
  }

  if (connectionState === 'CONFLICT' || disconnectState === 'CONFLICT') {
    return {
      tone: 'conflict',
      label: 'Em conflito',
      description: 'A sessão precisa ser reconectada para voltar ao estado normal.',
    };
  }

  if (
    ['UNPAIRED', 'UNPAIRED_IDLE', 'DISCONNECTEDMOBILE', 'DISCONNECTED', 'PHONENOTCONNECTED'].includes(connectionState)
    || ['UNPAIRED', 'UNPAIRED_IDLE', 'DISCONNECTEDMOBILE', 'DISCONNECTED', 'PHONENOTCONNECTED'].includes(disconnectState)
  ) {
    return {
      tone: 'reconnect',
      label: 'Desconectado',
      description: 'A sessão foi desconectada e precisa de uma nova autenticação.',
    };
  }

  if (status === 'qr' || ['PAIRING', 'OPENING', 'UNLAUNCHED'].includes(connectionState)) {
    return {
      tone: 'reconnect',
      label: 'Reconectando',
      description: 'Leia o QR Code ou use o código abaixo para conectar novamente.',
    };
  }

  return {
    tone: 'waiting',
    label: 'Aguardando',
    description: snapshot.message || 'Aguardando atualização do WhatsApp.',
  };
};

mergeSnapshot = function mergeSnapshot(snapshot) {
  const previous = readSnapshot();
  const next = {
    ...previous,
    ...snapshot,
    updatedAt: snapshot.updatedAt || nowIso(),
  };

  if (snapshot.status === 'connected') {
    next.lastConnectedAt = snapshot.lastConnectedAt || next.updatedAt;
  } else if (!next.lastConnectedAt && previous.lastConnectedAt) {
    next.lastConnectedAt = previous.lastConnectedAt;
  }

  if (!next.connectionState) {
    next.connectionState = previous.connectionState || '';
  }

  if (snapshot.status === 'connected') {
    next.disconnectState = '';
    next.disconnectedAt = '';
  } else if (snapshot.disconnectState) {
    next.disconnectState = snapshot.disconnectState;
    next.disconnectedAt = snapshot.disconnectedAt || next.updatedAt;
  } else {
    next.disconnectState = previous.disconnectState || '';
    next.disconnectedAt = previous.disconnectedAt || '';
  }

  return next;
};

publishQrCode = function publishQrCode({ base64Qr, attempts = 0, urlCode = '', connectionState = 'PAIRING' } = {}) {
  const imageSrc = normalizeDataUrl(base64Qr);
  if (!imageSrc) return;
  writeSnapshot({
    status: 'qr',
    attempts,
    urlCode,
    pairingCode: extractPairingCode(urlCode),
    imageSrc,
    connectionState,
    updatedAt: nowIso(),
  });
};

publishState = function publishState(connectionState, message = '') {
  const normalized = normalizeState(connectionState);
  if (!normalized) {
    publishMessage(message);
    return;
  }

  if (isConnectedState(normalized)) {
    publishConnected(normalized);
    return;
  }

  const disconnectedStates = ['CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE', 'DISCONNECTEDMOBILE', 'DISCONNECTED', 'PHONENOTCONNECTED'];
  const waitingMessage = message
    || (
      disconnectedStates.includes(normalized)
        ? 'A sessão foi desconectada e precisa ser reconectada.'
        : 'WhatsApp aguardando conexão.'
    );

  writeSnapshot({
    status: 'waiting',
    message: waitingMessage,
    connectionState: normalized,
    disconnectState: disconnectedStates.includes(normalized) ? normalized : '',
    disconnectedAt: disconnectedStates.includes(normalized) ? nowIso() : '',
    updatedAt: nowIso(),
  });
};

module.exports = {
  publishConnected,
  publishLivePageScreenshot,
  publishMessage,
  publishQrCode,
  publishState,
};
