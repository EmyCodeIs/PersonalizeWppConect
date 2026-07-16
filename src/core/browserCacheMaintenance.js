'use strict';

const fs = require('fs');
const path = require('path');

function bool(name, fallback = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(raw).trim().toLowerCase());
}

function number(name, fallback, minimum = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function scanBrowserCache(options = {}) {
  const root = path.resolve(
    options.cwd || process.cwd(),
    options.root || process.env.BROWSER_CACHE_DIR || 'data/browser-cache',
  );
  const maxAgeDays = number('BROWSER_CACHE_MAX_AGE_DAYS', 3, 0);
  const maxBytes = number('BROWSER_CACHE_MAX_MB', 200, 1) * 1024 * 1024;
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const files = [];
  let totalBytes = 0;

  if (!fs.existsSync(root)) {
    return { root, exists: false, totalBytes, maxBytes, maxAgeDays, files, selected: [] };
  }

  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      let stat;
      try { stat = fs.lstatSync(fullPath); } catch (_) { continue; }
      if (!stat.isFile()) continue;
      totalBytes += stat.size;
      files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }

  const overLimit = totalBytes >= maxBytes;
  const selected = files.filter((file) => overLimit || file.mtimeMs <= cutoff);
  return { root, exists: true, totalBytes, maxBytes, maxAgeDays, files, selected, overLimit };
}

function removeEmptyDirectories(root) {
  if (!fs.existsSync(root)) return;
  const directories = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    directories.push(current);
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) if (entry.isDirectory()) stack.push(path.join(current, entry.name));
  }
  directories.sort((a, b) => b.length - a.length);
  for (const directory of directories) {
    if (directory === root) continue;
    try { if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory); } catch (_) {}
  }
}

function runStartupBrowserCacheMaintenance(options = {}) {
  const scan = scanBrowserCache(options);
  if (!scan.exists) {
    fs.mkdirSync(scan.root, { recursive: true });
    console.log(`[CACHE-CHROME][INÍCIO] diretório criado: ${scan.root}`);
    return { ...scan, removedFiles: 0, removedBytes: 0 };
  }

  if (!bool('BROWSER_CACHE_AUTO_CLEAN', true)) {
    console.log(`[CACHE-CHROME][INÍCIO] limpeza desativada | total=${formatBytes(scan.totalBytes)}`);
    return { ...scan, removedFiles: 0, removedBytes: 0, skipped: true };
  }

  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of scan.selected) {
    try {
      fs.unlinkSync(file.path);
      removedFiles += 1;
      removedBytes += file.size;
    } catch (_) {}
  }
  removeEmptyDirectories(scan.root);

  console.log(
    `[CACHE-CHROME][INÍCIO] total=${formatBytes(scan.totalBytes)} | removido=${formatBytes(removedBytes)} `
    + `| arquivos=${removedFiles} | política=${scan.overLimit ? 'limite_de_tamanho' : `${scan.maxAgeDays}d`}`,
  );
  return { ...scan, removedFiles, removedBytes };
}

function startBrowserCacheMonitor(options = {}) {
  const intervalHours = number('BROWSER_CACHE_LOG_INTERVAL_HOURS', 6, 1);
  const report = () => {
    const scan = scanBrowserCache(options);
    if (!scan.exists) return;
    const level = scan.totalBytes >= scan.maxBytes ? 'AVISO' : 'STATUS';
    console.log(
      `[CACHE-CHROME][${level}] total=${formatBytes(scan.totalBytes)} `
      + `| limite=${formatBytes(scan.maxBytes)} | limpezaNoPróximoReinício=${formatBytes(scan.selected.reduce((sum, file) => sum + file.size, 0))}`,
    );
  };
  const timer = setInterval(report, intervalHours * 60 * 60 * 1000);
  timer.unref?.();
  return { timer, report };
}

module.exports = {
  formatBytes,
  runStartupBrowserCacheMaintenance,
  scanBrowserCache,
  startBrowserCacheMonitor,
};
