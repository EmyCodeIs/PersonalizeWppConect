'use strict';

function parseExtraArgs(value) {
  return String(value || '')
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveBrowserArgs(options = {}) {
  const platform = options.platform || process.platform;
  const isRoot = options.isRoot ?? (
    typeof process.getuid === 'function' && process.getuid() === 0
  );
  const configured = options.configured ?? process.env.WPP_BROWSER_ARGS;
  const args = parseExtraArgs(configured);

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
  parseExtraArgs,
  resolveBrowserArgs,
};
