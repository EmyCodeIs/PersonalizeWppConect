'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personalize-browser-cache-'));
const cacheDir = path.join(tempDir, 'data', 'browser-cache');
fs.mkdirSync(path.join(cacheDir, 'Cache'), { recursive: true });
fs.writeFileSync(path.join(cacheDir, 'Cache', 'old.bin'), Buffer.alloc(1024));
const old = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000));
fs.utimesSync(path.join(cacheDir, 'Cache', 'old.bin'), old, old);

process.env.BROWSER_CACHE_DIR = cacheDir;
process.env.BROWSER_CACHE_MAX_AGE_DAYS = '3';
process.env.BROWSER_CACHE_MAX_MB = '200';
process.env.BROWSER_CACHE_AUTO_CLEAN = 'true';

const BrowserCache = require('../src/core/browserCacheMaintenance');
const before = BrowserCache.scanBrowserCache({ cwd: tempDir });
assert.equal(before.files.length, 1);
assert.equal(before.selected.length, 1);

const result = BrowserCache.runStartupBrowserCacheMaintenance({ cwd: tempDir });
assert.equal(result.removedFiles, 1);
assert.equal(fs.existsSync(path.join(cacheDir, 'Cache', 'old.bin')), false);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log('✅ Cache pesado do Chrome validado fora de tokens e limpo no reinício seguro.');
