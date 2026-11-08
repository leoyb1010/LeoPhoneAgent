#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../app/entry/src/main/ets/', import.meta.url));
// Brand identities are data. MailTools emits external email HTML, not ArkUI styling.
const colorExceptions = new Set(['local/ProviderCatalog.ets', 'local/MailTools.ets']);
export function inspectUI(source, relative) {
  const failures = [];
  if (/SurfaceButton\(\)\s*\{/.test(source)) failures.push(`${relative}: use explicit named @Builder content for SurfaceButton before chaining attributes`);
  if (/@State\s+width\s*:/.test(source)) failures.push(`${relative}: state must not shadow CustomComponent.width`);
  if (source.includes("'@kit.ImeKit'")) failures.push(`${relative}: SDK kit is @kit.IMEKit (case sensitive)`);
  if (source.includes('Copy.sectionLook')) failures.push(`${relative}: Copy.sectionAppearance is the declared group key`);
  if (relative.startsWith('theme/')) return failures;
  for (const [index, line] of source.split('\n').entries()) {
    if (!colorExceptions.has(relative) && /['"`]#[\da-fA-F]{3,8}\b/.test(line)) failures.push(`${relative}:${index + 1}: use a semantic Tokens color`);
    if (/\bButton\s*\(/.test(line)) failures.push(`${relative}:${index + 1}: use a themed button`);
    if (/\bText\s*\(\s*['"]返回['"]/.test(line) || /label\s*:\s*['"]返回['"]/.test(line)) failures.push(`${relative}:${index + 1}: use a back symbol with an accessible label`);
  }
  return failures;
}
export function checkTree(dir = root) {
  const failures = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.ets')) failures.push(...inspectUI(fs.readFileSync(full, 'utf8'), path.relative(dir, full)));
    }
  }
  visit(dir);
  return failures;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkTree();
  console.log(failures.length ? failures.join('\n') : 'UI tokens: 0 violations (static source gate only)');
  process.exitCode = failures.length ? 1 : 0;
}
