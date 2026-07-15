'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');
const cleanAllCache = process.argv.includes('--all-cache');
const tokenRoot = path.resolve(process.cwd(), process.env.TOKEN_CACHE_ROOT || 'tokens');
const maxAgeDays = Math.max(0, Number(process.env.TOKEN_CACHE_MAX_AGE_DAYS || 7));
const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

const CACHE_DIRECTORY_NAMES = new Set([
  'cache',
  'code cache',
  'gpucache',
  'grshadercache',
  'shadercache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'cachestorage',
  'scriptcache',
  'blob_storage',
  'browsermetrics',
]);

const ACTIVE_PROFILE_MARKERS = new Set([
  'singletonlock',
  'singletoncookie',
  'singletonsocket',
  'devtoolsactiveport',
]);

function safeStat(filePath) {
  try { return fs.lstatSync(filePath); } catch (_) { return null; }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function isCacheDirectory(dirPath) {
  const name = path.basename(dirPath).toLowerCase();
  if (CACHE_DIRECTORY_NAMES.has(name)) return true;

  const normalized = dirPath.replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('/crashpad/reports');
}

function listDirectories(root) {
  const found = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (isCacheDirectory(fullPath)) {
        found.push(fullPath);
        continue;
      }
      stack.push(fullPath);
    }
  }

  return found;
}

function listFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else files.push(fullPath);
    }
  }

  return files;
}

function recentProfileMarkers(root) {
  const markers = [];
  const stack = [{ dir: root, depth: 0 }];
  const recentCutoff = Date.now() - (15 * 60 * 1000);

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 5) continue;

    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }

      if (!ACTIVE_PROFILE_MARKERS.has(entry.name.toLowerCase())) continue;
      const stat = safeStat(fullPath);
      if (stat && stat.mtimeMs >= recentCutoff) markers.push(fullPath);
    }
  }

  return markers;
}

function removeEmptyDirectories(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    removeEmptyDirectories(path.join(root, entry.name));
  }

  try {
    if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch (_) {}
}

function main() {
  if (!fs.existsSync(tokenRoot)) {
    console.log(`[TOKENS] pasta não encontrada: ${tokenRoot}`);
    return;
  }

  const markers = recentProfileMarkers(tokenRoot);
  if (markers.length && !force) {
    console.error('[TOKENS] o perfil parece estar em uso. Pare o npm start/PM2 e tente novamente.');
    for (const marker of markers.slice(0, 5)) console.error(`- ${path.relative(tokenRoot, marker)}`);
    process.exitCode = 2;
    return;
  }

  const cacheDirectories = listDirectories(tokenRoot);
  const selected = [];
  let selectedBytes = 0;
  let totalCacheBytes = 0;

  for (const dir of cacheDirectories) {
    for (const filePath of listFiles(dir)) {
      const stat = safeStat(filePath);
      if (!stat || !stat.isFile()) continue;
      totalCacheBytes += stat.size;
      if (!cleanAllCache && stat.mtimeMs > cutoff) continue;
      selected.push(filePath);
      selectedBytes += stat.size;
    }
  }

  console.log(`[TOKENS] raiz: ${tokenRoot}`);
  console.log(`[TOKENS] diretórios de cache encontrados: ${cacheDirectories.length}`);
  console.log(`[TOKENS] cache total identificado: ${formatBytes(totalCacheBytes)}`);
  console.log(
    `[TOKENS] selecionado para ${apply ? 'remoção' : 'simulação'}: `
    + `${selected.length} arquivo(s), ${formatBytes(selectedBytes)} `
    + `${cleanAllCache ? '(todo o cache)' : `(mais antigos que ${maxAgeDays} dia(s))`}`,
  );

  if (!apply) {
    console.log('[TOKENS] nenhuma alteração realizada. Para limpar: npm run tokens:cache:clean');
    return;
  }

  let removed = 0;
  let removedBytes = 0;
  const failures = [];

  for (const filePath of selected) {
    const stat = safeStat(filePath);
    try {
      fs.unlinkSync(filePath);
      removed += 1;
      removedBytes += stat?.size || 0;
    } catch (error) {
      failures.push(`${path.relative(tokenRoot, filePath)}: ${error?.message || error}`);
    }
  }

  for (const dir of cacheDirectories.sort((a, b) => b.length - a.length)) {
    removeEmptyDirectories(dir);
  }

  console.log(`[TOKENS] removidos: ${removed} arquivo(s), ${formatBytes(removedBytes)}`);
  if (failures.length) {
    console.warn(`[TOKENS] falhas: ${failures.length}`);
    for (const failure of failures.slice(0, 10)) console.warn(`- ${failure}`);
    process.exitCode = 1;
  }

  console.log('[TOKENS] autenticação preservada: Cookies, IndexedDB, Local Storage e Session Storage não foram selecionados.');
}

main();
