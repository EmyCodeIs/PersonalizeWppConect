'use strict';

function maskText(value) {
  return String(value || '')
    .replace(/\b(\d{4})\d{5,10}(\d{3})(?=@(?:c\.us|lid)\b)/gi, '$1*****$2')
    .replace(/\b(\d{4})\d{5,10}(\d{3})\b/g, '$1*****$2')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1***@')
    .replace(/(DATA_ENCRYPTION_KEY|VPS_BACKUP_PASSPHRASE)=([^\s]+)/gi, '$1=***');
}

function sanitizeArgument(value) {
  if (typeof value === 'string') return maskText(value);
  if (value instanceof Error) {
    const copy = new Error(maskText(value.message));
    copy.name = value.name;
    copy.stack = maskText(value.stack || copy.stack || '');
    return copy;
  }
  return value;
}

function installSafeLogging() {
  if (global.__personalizeSafeLoggingInstalled) return;
  for (const method of ['log', 'warn', 'error', 'info']) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(...args.map(sanitizeArgument));
  }
  global.__personalizeSafeLoggingInstalled = true;
}

installSafeLogging();

module.exports = {
  installSafeLogging,
  maskText,
};
