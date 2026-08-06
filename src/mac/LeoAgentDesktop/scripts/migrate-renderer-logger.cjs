/**
 * One-shot migration: rewrites `import { logger } from '@/lib/logger'` +
 * `logger.log/warn/error` calls in apps/desktop/src/renderer to the new
 * `createLogger`-based API. Idempotent.
 *
 * Run from repo root:
 *   node scripts/migrate-renderer-logger.cjs
 *
 * Skips:
 *   - __tests__/**
 *   - lib/logger.ts (the module itself)
 *   - *.d.ts
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');

const SKIP_DIR = new Set(['__tests__']);

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      walk(path.join(dir, ent.name), files);
    } else if (ent.isFile()) {
      const p = path.join(dir, ent.name);
      if (p === path.join(ROOT, 'lib', 'logger.ts')) continue;
      if (ent.name.endsWith('.d.ts')) continue;
      if (!ent.name.endsWith('.ts') && !ent.name.endsWith('.tsx')) continue;
      files.push(p);
    }
  }
  return files;
}

function scopeFromPath(filePath) {
  let base = path.basename(filePath).replace(/\.(ts|tsx)$/, '');
  if (base === 'index') {
    base = path.basename(path.dirname(filePath));
  }
  // PascalCase the scope so renderer scopes are visually distinct in main.log.
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function migrate(filePath) {
  const original = fs.readFileSync(filePath, 'utf-8');
  let src = original;

  // Quick check: does this file use the old `logger` import?
  if (!/import\s*\{\s*logger\s*\}\s*from\s*['"]@\/lib\/logger['"]/.test(src)) {
    return { changed: false, count: 0 };
  }

  let count = 0;
  // logger.X( → log.Y(  (only when preceded by safe lead chars)
  src = src.replace(
    /(^|[\s;{(,])logger\.(log|info|warn|error|debug|trace)\(/g,
    (_m, lead, fn) => {
      count++;
      const map = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug', trace: 'trace' };
      return `${lead}log.${map[fn]}(`;
    },
  );

  // Swap the import.
  src = src.replace(
    /import\s*\{\s*logger\s*\}\s*from\s*(['"])@\/lib\/logger\1\s*;?/,
    `import { createLogger } from '@/lib/logger';`,
  );

  // Inject `const log = createLogger(...)` after that import line if missing.
  if (!/\bconst\s+log\s*=\s*createLogger\b/.test(src)) {
    const scope = scopeFromPath(filePath);
    src = src.replace(
      /(import\s*\{\s*createLogger\s*\}\s*from\s*['"]@\/lib\/logger['"]\s*;?)/,
      `$1\n\nconst log = createLogger('${scope}');`,
    );
  }

  if (src !== original) {
    fs.writeFileSync(filePath, src);
    return { changed: true, count };
  }
  return { changed: false, count: 0 };
}

const files = walk(ROOT);
const summary = [];
let total = 0;
for (const f of files) {
  const r = migrate(f);
  if (r.changed) {
    summary.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), count: r.count });
    total += r.count;
  }
}
process.stdout.write(`Files changed: ${summary.length}\n`);
process.stdout.write(`Total replacements: ${total}\n`);
for (const s of summary) {
  process.stdout.write(`  ${String(s.count).padStart(3)}  ${s.file}\n`);
}
