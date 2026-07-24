'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const root = path.resolve(__dirname, '..');
const ignoredDirectories = new Set([
  '.git',
  'assets',
  'cache',
  'data',
  'node_modules',
  'tokens',
]);

const textFilePattern = /\.(?:c?js|mjs|json|md|txt|ya?ml|ps1|sh|conf|example|css|html)(?:\.bak-[^/\\]+)?$/i;
const namedTextFiles = new Set([
  '.env.example',
  '.env.windows.example',
  '.gitignore',
  'Dockerfile',
]);

const forbiddenPatterns = Object.freeze([
  {
    id: 'caractere-substituto',
    pattern: /\uFFFD/u,
    message: 'caractere substituto U+FFFD; o texto já foi decodificado com perda',
  },
  {
    id: 'mojibake-utf8',
    pattern: /(?:Ã[\u0080-\u00BF]|Â(?:[\u0080-\u00BF]|\s|[·°ºª])|â(?:[\u0080-\u00BF\u2010-\u203F\u20AC\u2122])|ð(?:[\u0080-\u00BF\u0178])|ï(?:[\u0080-\u00BF\u00BF]))/u,
    message: 'sequência típica de UTF-8 interpretado como Latin-1/Windows-1252',
  },
  {
    id: 'controle-c1',
    pattern: /[\u0080-\u009F]/u,
    message: 'caractere de controle C1 invisível',
  },
  {
    id: 'controle-bidirecional',
    pattern: /[\u202A-\u202E\u2066-\u2069]/u,
    message: 'controle bidirecional invisível',
  },
  {
    id: 'invisivel-perigoso',
    pattern: /[\u00AD\u200B\u2060]/u,
    message: 'caractere invisível que pode alterar comparação ou exibição',
  },
  {
    id: 'bom-interno',
    pattern: /\uFEFF/u,
    message: 'BOM encontrado no meio do arquivo',
  },
]);

function isTextFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  return textFilePattern.test(normalized) || namedTextFiles.has(path.basename(normalized));
}

function collectRecursively(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectRecursively(fullPath, output);
    else if (isTextFile(fullPath)) output.push(fullPath);
  }
  return output;
}

function trackedTextFiles() {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });

  if (git.status === 0) {
    return String(git.stdout || '')
      .split('\0')
      .filter(Boolean)
      .filter(isTextFile)
      .map((relativePath) => path.join(root, relativePath));
  }

  return collectRecursively(root);
}

function locationOf(text, index) {
  const before = text.slice(0, Math.max(0, index));
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1) || '').length + 1,
  };
}

function excerptAt(text, index) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const lineEnd = text.indexOf('\n', index);
  return text
    .slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function inspectText(text, file = '<texto>') {
  const issues = [];
  const withoutLeadingBom = text.startsWith('\uFEFF') ? text.slice(1) : text;

  if (withoutLeadingBom !== withoutLeadingBom.normalize('NFC')) {
    issues.push({
      file,
      id: 'normalizacao',
      line: 1,
      column: 1,
      message: 'texto não está normalizado em Unicode NFC',
      excerpt: '',
    });
  }

  for (const rule of forbiddenPatterns) {
    const match = rule.pattern.exec(withoutLeadingBom);
    if (!match) continue;
    const location = locationOf(withoutLeadingBom, match.index);
    issues.push({
      file,
      id: rule.id,
      ...location,
      message: rule.message,
      excerpt: excerptAt(withoutLeadingBom, match.index),
    });
  }

  return issues;
}

function inspectFile(filePath) {
  const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
  const bytes = fs.readFileSync(filePath);
  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return [{
      file: relativePath,
      id: 'utf8-invalido',
      line: 1,
      column: 1,
      message: `arquivo não é UTF-8 válido: ${error.message}`,
      excerpt: '',
    }];
  }

  return inspectText(text, relativePath);
}

function run() {
  const files = trackedTextFiles().sort((a, b) => a.localeCompare(b));
  const issues = files.flatMap(inspectFile);

  if (issues.length) {
    console.error(`❌ Integridade textual falhou em ${issues.length} ocorrência(s):`);
    for (const issue of issues) {
      console.error(`\n- ${issue.file}:${issue.line}:${issue.column} [${issue.id}]`);
      console.error(`  ${issue.message}`);
      if (issue.excerpt) console.error(`  ${JSON.stringify(issue.excerpt)}`);
    }
    console.error('\nCorrija a origem do texto. Não esconda a ocorrência na lista de exceções.');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ UTF-8 e integridade textual verificados em ${files.length} arquivo(s).`);
}

if (require.main === module) run();

module.exports = {
  inspectFile,
  inspectText,
  isTextFile,
};
