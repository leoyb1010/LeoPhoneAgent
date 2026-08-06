// CI guard: fail if helpKnowledge.generated.ts is out of sync with
// help-knowledge/*.md (someone edited a doc but forgot `pnpm gen:help-kb`, or
// hand-edited the generated file). Regenerates in memory and compares — never
// writes. Mirrors the scheduler-guard pattern (hard ERROR + exit 1).
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { renderHelpKnowledgeModule } from './gen-help-kb.mjs';

const { outPath, content } = renderHelpKnowledgeModule();

let committed = '';
try {
  committed = readFileSync(outPath, 'utf8');
} catch {
  committed = '';
}

// Normalize EOL so a CRLF checkout (Windows) doesn't false-positive against the
// LF the generator emits.
const norm = (s) => s.replace(/\r\n/g, '\n');

if (norm(committed) !== norm(content)) {
  console.error('❌  [help-kb-guard] FAIL — helpKnowledge.generated.ts is out of sync with help-knowledge/*.md');
  console.error('    Fix: run `pnpm gen:help-kb` and commit the regenerated file.');
  process.exit(1);
}

console.log('✅  [help-kb-guard] PASS — generated KB is in sync with help-knowledge/*.md');
