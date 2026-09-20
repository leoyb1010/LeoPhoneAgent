import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { clearPeekFileDraft, peekFileDraftToRestore, writePeekFileDraft } from './session-peek-files';

test('换文件时改过的预览还在', () => {
  const bag = new Map<string, Map<string, string>>();
  writePeekFileDraft(bag, 'local:a', 'src/a.ts', 'old', 'new');
  writePeekFileDraft(bag, 'local:a', 'src/b.ts', 'bb', 'bb');
  assert.equal(peekFileDraftToRestore(bag, 'local:a', 'src/a.ts'), 'new');
  assert.equal(peekFileDraftToRestore(bag, 'local:a', 'src/b.ts'), null);
  assert.equal(peekFileDraftToRestore(bag, 'local:b', 'src/a.ts'), null);
  writePeekFileDraft(bag, 'local:a', 'src/a.ts', '正在读…', 'new');
  assert.equal(peekFileDraftToRestore(bag, 'local:a', 'src/a.ts'), 'new');
  clearPeekFileDraft(bag, 'local:a', 'src/a.ts');
  assert.equal(peekFileDraftToRestore(bag, 'local:a', 'src/a.ts'), null);
});

test('2.0 换文件预览不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /writePeekFileDraft/);
  assert.match(app, /peekFileDraftToRestore/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /换文件|peekFileDraft/);
});
