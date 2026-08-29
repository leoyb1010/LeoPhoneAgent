import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateDiff, createCachedDiffCalculator, type DiffLine } from './messageTransforms';

test('calculateDiff treats null/undefined/non-string sides as empty', () => {
  assert.deepEqual(calculateDiff(null as never, 'hello'), [
    { type: 'added', content: 'hello', lineNum: 1 },
  ]);
  assert.deepEqual(calculateDiff('hello', undefined as never), [
    { type: 'removed', content: 'hello', lineNum: 1 },
  ]);
  assert.doesNotThrow(() => calculateDiff({} as never, 12 as never));
});

test('calculateDiff aligns a small insertion without rewriting the rest', () => {
  const diff = calculateDiff('a\nb\nc', 'a\nx\nb\nc');
  assert.deepEqual(diff, [{ type: 'added', content: 'x', lineNum: 2 }]);
});

test('calculateDiff does not allocate an LCS table for huge files', () => {
  const oldStr = Array.from({ length: 1200 }, (_, i) => `old-${i}`).join('\n');
  const newStr = `header\n${oldStr}`;
  let diff: DiffLine[] | undefined;
  assert.doesNotThrow(() => {
    diff = calculateDiff(oldStr, newStr);
  });
  assert.equal(diff?.[0]?.type, 'added');
  assert.equal(diff?.[0]?.content, 'header');
  assert.equal(diff?.length, 1);
});

test('cached calculator skips stringify of large payloads and still returns a diff', () => {
  const calc = createCachedDiffCalculator();
  const oldStr = 'x'.repeat(40_000);
  const newStr = `${oldStr}y`;
  assert.doesNotThrow(() => calc(oldStr, newStr));
  assert.equal(calc(null as never, 'ok')[0]?.content, 'ok');
});
