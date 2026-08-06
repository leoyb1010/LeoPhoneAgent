#!/usr/bin/env node
// One-shot migration: console.log/warn/error → logger.log/warn/error
// + ensure `import { logger } from '@/lib/logger';` exists.
// Skips: __tests__, lib/logger.ts itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync(
  `grep -rln "console\\.\\(log\\|warn\\|error\\|info\\|debug\\)" src/renderer --include="*.ts" --include="*.tsx"`,
  { encoding: 'utf8' }
)
  .split('\n')
  .filter((f) => f && !f.includes('__tests__') && !f.endsWith('lib/logger.ts'));

const IMPORT_LINE = `import { logger } from '@/lib/logger';`;

let totalReplaced = 0;
let filesTouched = 0;

for (const file of files) {
  const orig = readFileSync(file, 'utf8');
  // Map console.{log,warn,error,info,debug} → logger.{log,warn,error}
  // Note: info/debug both map to log (renderer logger has no separate channels).
  let next = orig
    .replace(/\bconsole\.log\(/g, 'logger.log(')
    .replace(/\bconsole\.warn\(/g, 'logger.warn(')
    .replace(/\bconsole\.error\(/g, 'logger.error(')
    .replace(/\bconsole\.info\(/g, 'logger.log(')
    .replace(/\bconsole\.debug\(/g, 'logger.log(');

  if (next === orig) continue;

  // Count replacements
  const replaced =
    (orig.match(/\bconsole\.(log|warn|error|info|debug)\(/g) || []).length;

  // Ensure import — insert after the last existing top-level import.
  if (!next.includes(IMPORT_LINE)) {
    const importRegex = /^import .+;$/gm;
    let lastImportEnd = 0;
    let m;
    while ((m = importRegex.exec(next)) !== null) {
      lastImportEnd = m.index + m[0].length;
    }
    if (lastImportEnd > 0) {
      next =
        next.slice(0, lastImportEnd) +
        '\n' +
        IMPORT_LINE +
        next.slice(lastImportEnd);
    } else {
      // No imports yet — prepend.
      next = IMPORT_LINE + '\n' + next;
    }
  }

  writeFileSync(file, next, 'utf8');
  totalReplaced += replaced;
  filesTouched++;
  console.log(`  ${file}  (${replaced} call${replaced === 1 ? '' : 's'})`);
}

console.log(`\nDone. Files touched: ${filesTouched}, calls migrated: ${totalReplaced}`);
