/**
 * Post-migration cleanup: remove redundant `[scope]` prefixes from log call
 * messages, where `[scope]` matches the file's createLogger scope name
 * (case-insensitive).
 *
 * Examples (file with scope `updateService`):
 *   log.info('[updateService] foo')         → log.info('foo')
 *   log.info('[UpdateService] foo: %s', x)  → log.info('foo: %s', x)
 *   log.info(`[updateService] foo`)         → log.info(`foo`)
 *   log.info('[updateService]', err)        → log.info(err)         (bare prefix arg dropped)
 *
 * Preserved (prefix doesn't equal scope):
 *   log.info('[Startup] foo')               (sub-tag)
 *   log.info('[feishuBot/replyClient] foo') (more info than scope)
 *
 * Idempotent. Run from repo root:
 *   node scripts/strip-scope-prefix.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOTS = [
  path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main'),
  path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer'),
];
const SKIP_DIR = new Set(['__tests__', 'third_party', 'node_modules']);
const SKIP_FILE = new Set(['logger.ts']);

function walk(dir, files = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      walk(path.join(dir, ent.name), files);
    } else if (ent.isFile()) {
      if (SKIP_FILE.has(ent.name)) continue;
      if (ent.name.endsWith('.d.ts')) continue;
      if (!ent.name.endsWith('.ts') && !ent.name.endsWith('.tsx')) continue;
      files.push(path.join(dir, ent.name));
    }
  }
  return files;
}

function getScope(src) {
  const m = /createLogger\(\s*['"]([^'"]+)['"]\s*\)/.exec(src);
  return m ? m[1] : null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPrefixes(filePath) {
  const original = fs.readFileSync(filePath, 'utf-8');
  const scope = getScope(original);
  if (!scope) return { changed: false, count: 0 };

  const escScope = escapeRegex(scope);
  let src = original;
  let count = 0;

  // Pattern A: log.X(<quote>[scope] <stuff>...)
  //   Strip the `[scope] ` part. Keeps the rest of the string arg intact.
  //   Quote can be ', ", or `.
  const reA = new RegExp(
    `(\\blog\\.(?:trace|debug|info|warn|error|fatal)\\(\\s*(['"\`]))\\[${escScope}\\]\\s+`,
    'gi',
  );
  src = src.replace(reA, (_m, prefix) => {
    count++;
    return prefix;
  });

  // Pattern B: log.X(<quote>[scope]<quote> [, ...] )
  //   The first arg is JUST the prefix — drop the whole first arg.
  //   If it was the only arg, leave an empty string so the call still type-checks.
  const reB = new RegExp(
    `\\blog\\.(trace|debug|info|warn|error|fatal)\\(\\s*(['"\`])\\[${escScope}\\]\\2(\\s*,\\s*|\\s*\\))`,
    'gi',
  );
  src = src.replace(reB, (_m, level, _q, sep) => {
    count++;
    if (sep.trim() === ')') {
      return `log.${level}(''` + sep;
    }
    return `log.${level}(`;
  });

  if (src !== original) {
    fs.writeFileSync(filePath, src);
    return { changed: true, count };
  }
  return { changed: false, count: 0 };
}

const files = ROOTS.flatMap((r) => walk(r));
const summary = [];
let total = 0;
for (const f of files) {
  const r = stripPrefixes(f);
  if (r.changed) {
    summary.push({
      file: path.relative(REPO_ROOT, f).replace(/\\/g, '/'),
      count: r.count,
    });
    total += r.count;
  }
}
process.stdout.write(`Files changed: ${summary.length}\nTotal strips: ${total}\n`);
for (const s of summary) {
  process.stdout.write(`  ${String(s.count).padStart(4)}  ${s.file}\n`);
}
