'use strict';

const assert = require('assert/strict');

process.env.MOCK_MODE = 'true';

const {
  parseExtraArgs,
  resolveBrowserArgs,
} = require('../src/core/vpsBrowserPreload');

assert.deepEqual(
  parseExtraArgs('--disable-gpu; --window-size=1366,768\n--lang=pt-BR'),
  ['--disable-gpu', '--window-size=1366,768', '--lang=pt-BR'],
);

assert.deepEqual(
  resolveBrowserArgs({ platform: 'win32', isRoot: false, configured: '' }),
  [],
);

assert.deepEqual(
  resolveBrowserArgs({ platform: 'linux', isRoot: false, configured: '' }),
  ['--disable-dev-shm-usage'],
);

assert.deepEqual(
  resolveBrowserArgs({ platform: 'linux', isRoot: true, configured: '' }),
  ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox'],
);

assert.deepEqual(
  resolveBrowserArgs({
    platform: 'linux',
    isRoot: true,
    configured: '--disable-dev-shm-usage;--lang=pt-BR',
  }),
  ['--disable-dev-shm-usage', '--lang=pt-BR', '--no-sandbox', '--disable-setuid-sandbox'],
);

console.log('✅ Chrome da VPS verificado: Linux, memória compartilhada e execução root.');
