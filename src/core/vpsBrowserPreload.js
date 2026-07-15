'use strict';

const path = require('path');

function parseExtraArgs(value) {
  return String(value || '')
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveMb(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasArg(args, prefix) {
  return args.some((arg) => String(arg).startsWith(prefix));
}

function resolveBrowserArgs(options = {}) {
  const platform = options.platform || process.platform;
  const isRoot = options.isRoot ?? (
    typeof process.getuid === 'function' && process.getuid() === 0
  );
  const configured = options.configured ?? process.env.WPP_BROWSER_ARGS;
  const args = parseExtraArgs(configured);
  const cwd = options.cwd || process.cwd();
  const cacheDir = path.resolve(
    cwd,
    options.cacheDir || process.env.BROWSER_CACHE_DIR || 'data/browser-cache',
  );
  const diskCacheBytes = Math.round(positiveMb(
    options.diskCacheMb ?? process.env.BROWSER_DISK_CACHE_MB,
    100,
  ) * 1024 * 1024);
  const mediaCacheBytes = Math.round(positiveMb(
    options.mediaCacheMb ?? process.env.BROWSER_MEDIA_CACHE_MB,
    50,
  ) * 1024 * 1024);

  // Mantém o cache volumoso fora de tokens/, que fica reservado à sessão e
  // autenticação. Os limites reduzem o crescimento durante longos períodos online.
  if (!hasArg(args, '--disk-cache-dir=')) args.push(`--disk-cache-dir=${cacheDir}`);
  if (!hasArg(args, '--disk-cache-size=')) args.push(`--disk-cache-size=${diskCacheBytes}`);
  if (!hasArg(args, '--media-cache-size=')) args.push(`--media-cache-size=${mediaCacheBytes}`);

  if (platform === 'linux') {
    args.push('--disable-dev-shm-usage');

    // Chrome não inicia como root sem desativar o sandbox. O recomendado para
    // produção continua sendo executar o PM2 com um usuário Linux dedicado.
    if (isRoot) {
      args.push('--no-sandbox', '--disable-setuid-sandbox');
    }
  }

  return [...new Set(args)];
}

module.exports = {
  hasArg,
  parseExtraArgs,
  positiveMb,
  resolveBrowserArgs,
};
