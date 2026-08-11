import assert from 'node:assert/strict';
import test from 'node:test';

import { arsenalContextWindow, arsenalPrice, getArsenalModel, listArsenal } from '@/shared/model-arsenal.js';

test('arsenal resolves the most specific model id within a provider', () => {
  // gpt-5-codex must win over the shorter "gpt-5" id.
  const codex = getArsenalModel('codex', 'gpt-5-codex-preview');
  assert.equal(codex?.id, 'gpt-5-codex');
  const gpt5 = getArsenalModel('codex', 'gpt-5-2026-01');
  assert.equal(gpt5?.id, 'gpt-5');
});

test('arsenal prefers a same-provider match before a cross-provider one', () => {
  // A Leoapi claude target pointing at a model literally named "sonnet".
  const entry = getArsenalModel('claude', 'claude-sonnet-4-20260101');
  assert.equal(entry?.id, 'claude-sonnet-4');
  assert.equal(entry?.provider, 'claude');
});

test('arsenal context window and price are precise for a known model', () => {
  assert.equal(arsenalContextWindow('gemini', 'gemini-2.5-pro'), 1_048_576);
  const price = arsenalPrice('claude', 'claude-opus-4');
  assert.deepEqual(price, { input: 15, output: 75 });
});

test('unknown models degrade to null (never a fabricated value)', () => {
  assert.equal(getArsenalModel('mystery', 'totally-unknown-model'), null);
  assert.equal(arsenalContextWindow('mystery', 'totally-unknown-model'), null);
  assert.equal(arsenalPrice('mystery', 'totally-unknown-model'), null);
});

test('arsenal exposes a non-trivial, well-formed catalog', () => {
  const all = listArsenal();
  assert.ok(all.length >= 30, `expected >=30 models, got ${all.length}`);
  for (const m of all) {
    assert.ok(m.provider && m.id && m.label, 'each model has provider/id/label');
    assert.ok(m.contextWindow > 0 && m.maxOutput > 0, 'positive context/output');
    assert.ok(m.inputPerM >= 0 && m.outputPerM >= 0, 'non-negative prices');
  }
});
