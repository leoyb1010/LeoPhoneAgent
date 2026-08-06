/**
 * One-shot migration: rewrites console.log/info/warn/error/debug/trace in
 * apps/desktop/src/main → log.info/warn/error/debug/trace via the new
 * createLogger() module. Idempotent — safe to run twice.
 *
 * Run from repo root:
 *   node scripts/migrate-logger.cjs
 *
 * Skips:
 *   - __tests__/**       (tests keep using console for dev convenience)
 *   - third_party/**     (vendored, has its own logger conventions)
 *   - logger.ts          (the new logger itself)
 *   - *.d.ts
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MAIN_ROOT = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main');

const SKIP_DIR = new Set(['__tests__', 'third_party']);
const SKIP_FILE = new Set(['logger.ts']);

const LEVEL_MAP = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  trace: 'trace',
};

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      walk(path.join(dir, ent.name), files);
    } else if (ent.isFile()) {
      if (SKIP_FILE.has(ent.name)) continue;
      if (!ent.name.endsWith('.ts') || ent.name.endsWith('.d.ts')) continue;
      files.push(path.join(dir, ent.name));
    }
  }
  return files;
}

function relImportPath(filePath) {
  const fromDir = path.dirname(filePath);
  const targetFile = path.join(MAIN_ROOT, 'logger');
  let rel = path.relative(fromDir, targetFile).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function scopeFromPath(filePath) {
  const base = path.basename(filePath, '.ts');
  if (base === 'index') {
    return path.basename(path.dirname(filePath));
  }
  return base;
}

function migrate(filePath) {
  const original = fs.readFileSync(filePath, 'utf-8');
  let src = original;

  // Replace console.X( → log.Y( only when preceded by whitespace, ;, {, (
  // or comma — guards against matches inside string literals (lead is then
  // a quote or backtick, which we don't include).
  const callRx = /(^|[\s;{(,])console\.(log|info|warn|error|debug|trace)\(/g;
  let count = 0;
  src = src.replace(callRx, (_match, lead, fn) => {
    count++;
    return `${lead}log.${LEVEL_MAP[fn]}(`;
  });

  if (count === 0) return { changed: false, count: 0 };

  // Inject the import + log instance if missing.
  const importPath = relImportPath(filePath);
  const scope = scopeFromPath(filePath);

  const hasImport = /createLogger.*from\s+['"][^'"]*\/logger['"]/.test(src)
    || /from\s+['"][^'"]*\/logger['"][^;]*createLogger/.test(src);
  const hasInstance = /\bconst\s+log\s*=\s*createLogger\b/.test(src);

  if (!hasImport || !hasInstance) {
    // Find the position after the last top-level import statement.
    const importRx = /^import\s[^\n]+;\s*$/gm;
    let lastImportEnd = 0;
    let m;
    while ((m = importRx.exec(src)) !== null) {
      lastImportEnd = m.index + m[0].length;
    }

    let inject = '';
    if (!hasImport) inject += `\nimport { createLogger } from '${importPath}';`;
    if (!hasInstance) inject += `\n\nconst log = createLogger('${scope}');`;
    inject += '\n';

    if (lastImportEnd > 0) {
      src = src.slice(0, lastImportEnd) + inject + src.slice(lastImportEnd);
    } else {
      src = inject.trimStart() + src;
    }
  }

  if (src !== original) {
    fs.writeFileSync(filePath, src);
    return { changed: true, count };
  }
  return { changed: false, count: 0 };
}

const files = walk(MAIN_ROOT);
const summary = [];
let total = 0;
for (const f of files) {
  const r = migrate(f);
  if (r.changed) {
    summary.push({ file: path.relative(MAIN_ROOT, f).replace(/\\/g, '/'), count: r.count });
    total += r.count;
  }
}

process.stdout.write(`Files changed: ${summary.length}\n`);
process.stdout.write(`Total replacements: ${total}\n`);
for (const s of summary) {
  process.stdout.write(`  ${String(s.count).padStart(4)}  ${s.file}\n`);
}
