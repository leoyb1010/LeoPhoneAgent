import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';

import { estimateUsageCostUsd, getModelPrices, setModelPrices, usageDb } from './usage.db.js';

async function withDatabase(run: () => void | Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(tmpdir(), 'usage-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try { await run(); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('editable model prices drive cost estimation', { concurrency: false }, async () => {
  await withDatabase(() => {
    const prices = setModelPrices({ 'custom-model': { input: 2, output: 10 } });
    assert.deepEqual(prices['custom-model'], { input: 2, output: 10 });
    assert.deepEqual(getModelPrices()['custom-model'], { input: 2, output: 10 });
    assert.equal(estimateUsageCostUsd('codex', 'custom-model-v1', 1_000_000, 500_000), 7);
  });
});

test('a user override wins even when the model name contains a default-key substring', { concurrency: false }, async () => {
  await withDatabase(() => {
    // "custom-opus-v1" contains the built-in default key "opus" AND is arsenal-ish.
    // The user's explicit override must win over both the default table and the arsenal.
    setModelPrices({ 'custom-opus': { input: 1, output: 2 } });
    assert.equal(estimateUsageCostUsd('codex', 'custom-opus-v1', 1_000_000, 1_000_000), 3);
    // A provider-name-keyed override is honored too (grok is also a default key).
    setModelPrices({ 'custom-opus': { input: 1, output: 2 }, grok: { input: 0.1, output: 0.2 } });
    assert.equal(estimateUsageCostUsd('grok', 'grok-4', 1_000_000, 0), 0.1);
  });
});

test('usage aggregation groups daily provider/model totals', { concurrency: false }, async () => {
  await withDatabase(() => {
    usageDb.record({ projectPath: '/tmp/demo', provider: 'codex', model: 'gpt-5', inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
    usageDb.record({ projectPath: '/tmp/demo', provider: 'codex', model: 'gpt-5', inputTokens: 20, outputTokens: 10, costUsd: 0.5 });
    const [row] = usageDb.summary({ projectPath: '/tmp/demo', provider: 'codex' });
    assert.equal(row.sessionCount, 2);
    assert.equal(row.inputTokens, 30);
    assert.equal(row.outputTokens, 15);
    assert.equal(row.costUsd, 0.75);
  });
});
