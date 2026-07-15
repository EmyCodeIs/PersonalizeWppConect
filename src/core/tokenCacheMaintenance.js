'use strict';

const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

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

const PROFILE_MARKERS = new Set([
  'singletonlock',
  'singletoncookie',
  'singletonsocket',
  'devtoolsactiveport',
]);

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function safeStat(filePath) {
  try { return fs.lstatSync(filePath); } catch (_) { return null; }
}

function isCacheDirectory(dirPath) {
  const name = path.basename(dirPath).toLowerCase();
  if (CACHE_DIRECTORY_NAMES.has(name)) return true;
  return dirPath.replace(/\\/g, '/').toLowerCase().endsWith('/crashpad/reports');
}

function scanTokenCache(options = {}) {
  const root = path.resolve(options.cwd || process.cwd(), options.root || env.tokenCacheRoot || 'tokens');
  const maxAgeDays = Math.max(0, Number(options.maxAgeDays ?? env.tokenCacheMaxAgeDays ?? 7));
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const activeCutoff = Date.now() - (15 * 60 * 1000);
  const cacheFiles = [];
  const recentMarkers = [];
  let totalBytes = 0;
  let cacheBytes = 0;

  if (!fs.existsSync(root)) {
    return { root, exists: false, maxAgeDays, totalBytes, cacheBytes, removableBytes: 0, cacheFiles, recentMarkers };
  }

  const stack = [{ dir: root, insideCache: false, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > 12) continue;
    let entries = [];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch (_) { continue; }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        stack.push({
          dir: fullPath,
          insideCache: current.insideCache || isCacheDirectory(fullPath),
          depth: current.depth + 1,
        });
        continue;
      }

      const stat = safeStat(fullPath);
      if (!stat?.isFile()) continue;
      totalBytes += stat.size;

      if (PROFILE_MARKERS.has(entry.name.toLowerCase()) && stat.mtimeMs >= activeCutoff) {
        recentMarkers.push(fullPath);
      }

      if (!current.insideCache) continue;
      cacheBytes += stat.size;
      cacheFiles.push({
        path: fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        oldEnough: stat.mtimeMs <= cutoff,
      });
    }
  }

  const forceThresholdBytes = Math.max(0, Number(env.tokenCacheForceCleanMb || 300)) * 1024 * 1024;
  const cleanAllRecognizedCache = forceThresholdBytes > 0 && cacheBytes >= forceThresholdBytes;
  const selected = cacheFiles.filter((file) => cleanAllRecognizedCache || file.oldEnough);

  return {
    root,
    exists: true,
    maxAgeDays,
    totalBytes,
    cacheBytes,
    removableBytes: selected.reduce((sum, file) => sum + file.size, 0),
    cacheFiles,
    selected,
    recentMarkers,
    cleanAllRecognizedCache,
    forceThresholdBytes,
  };
}

function removeEmptyParents(filePath, stopAt) {
  let current = path.dirname(filePath);
  const root = path.resolve(stopAt);
  while (current.startsWith(root) && current !== root) {
    try {
      if (fs.readdirSync(current).length) break;
      fs.rmdirSync(current);
    } catch (_) { break; }
    current = path.dirname(current);
  }
}

function runStartupTokenCacheMaintenance(options = {}) {
  const scan = scanTokenCache(options);
  if (!scan.exists) {
    console.log(`[TOKENS][INÍCIO] pasta ainda não existe: ${scan.root}`);
    return { ...scan, removedBytes: 0, removedFiles: 0, skipped: true, reason: 'NOT_FOUND' };
  }

  console.log(
    `[TOKENS][INÍCIO] total=${formatBytes(scan.totalBytes)} | cacheReconhecido=${formatBytes(scan.cacheBytes)} `
    + `| selecionado=${formatBytes(scan.removableBytes)} | política=${scan.cleanAllRecognizedCache ? 'limite_de_tamanho' : `${scan.maxAgeDays}d`}`,
  );

  if (!env.tokenCacheAutoClean) {
    console.log('[TOKENS][INÍCIO] limpeza automática desativada; apenas monitoramento.');
    return { ...scan, removedBytes: 0, removedFiles: 0, skipped: true, reason: 'DISABLED' };
  }

  if (scan.recentMarkers.length) {
    console.warn(
      `[TOKENS][INÍCIO] limpeza adiada: perfil aparenta estar em uso `
      + `(${scan.recentMarkers.length} marcador(es) recente(s)).`,
    );
    return { ...scan, removedBytes: 0, removedFiles: 0, skipped: true, reason: 'PROFILE_ACTIVE' };
  }

  let removedBytes = 0;
  let removedFiles = 0;
  let failures = 0;
  for (const file of scan.selected || []) {
    try {
      fs.unlinkSync(file.path);
      removedBytes += file.size;
      removedFiles += 1;
      removeEmptyParents(file.path, scan.root);
    } catch (_) {
      failures += 1;
    }
  }

  console.log(
    `[TOKENS][INÍCIO] limpeza concluída | arquivos=${removedFiles} | liberado=${formatBytes(removedBytes)} `
    + `| falhas=${failures} | autenticação=preservada`,
  );
  return { ...scan, removedBytes, removedFiles, failures, skipped: false };
}

function startTokenCacheMonitor(options = {}) {
  const intervalHours = Math.max(1, Number(env.tokenCacheLogIntervalHours || 6));
  const warnBytes = Math.max(1, Number(env.tokenCacheWarnMb || 500)) * 1024 * 1024;

  const report = () => {
    const scan = scanTokenCache(options);
    if (!scan.exists) return;
    const level = scan.totalBytes >= warnBytes ? 'AVISO' : 'STATUS';
    console.log(
      `[TOKENS][${level}] total=${formatBytes(scan.totalBytes)} | cacheReconhecido=${formatBytes(scan.cacheBytes)} `
      + `| limpezaSeguraNoPróximoReinício=${formatBytes(scan.removableBytes)}`,
    );
  };

  const timer = setInterval(report, intervalHours * 60 * 60 * 1000);
  timer.unref?.();
  return { timer, report };
}

module.exports = {
  CACHE_DIRECTORY_NAMES,
  PROFILE_MARKERS,
  formatBytes,
  isCacheDirectory,
  runStartupTokenCacheMaintenance,
  scanTokenCache,
  startTokenCacheMonitor,
};
