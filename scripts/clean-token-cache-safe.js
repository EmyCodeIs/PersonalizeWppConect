'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROFILE_MARKERS = new Set([
  'singletonlock',
  'singletoncookie',
  'singletonsocket',
  'devtoolsactiveport',
]);

function findProfileMarkers(root, maxDepth = 6) {
  if (!fs.existsSync(root)) return [];
  const markers = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;

    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (PROFILE_MARKERS.has(entry.name.toLowerCase())) markers.push(fullPath);
    }
  }

  return markers;
}

function runCleaner(args = process.argv.slice(2), options = {}) {
  const root = path.resolve(options.cwd || process.cwd(), process.env.TOKEN_CACHE_ROOT || 'tokens');
  const force = args.includes('--force');
  const markers = findProfileMarkers(root);

  if (markers.length && !force) {
    console.error('[TOKENS] limpeza cancelada: o perfil possui marcador(es) de Chrome aberto ou não encerrado corretamente.');
    for (const marker of markers.slice(0, 10)) console.error(`- ${path.relative(root, marker)}`);
    console.error('[TOKENS] feche npm start/PM2 e todas as janelas do Chrome dessa sessão.');
    console.error('[TOKENS] use --force somente depois de confirmar que os marcadores são antigos.');
    return 2;
  }

  const cleanerPath = path.join(__dirname, 'clean-token-cache.js');
  const result = spawnSync(process.execPath, [cleanerPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (options.capture) {
    return {
      status: result.status ?? 1,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  }
  return result.status ?? 1;
}

if (require.main === module) {
  const status = runCleaner();
  if (typeof status === 'number' && status !== 0) process.exitCode = status;
}

module.exports = {
  PROFILE_MARKERS,
  findProfileMarkers,
  runCleaner,
};
