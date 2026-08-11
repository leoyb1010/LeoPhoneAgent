import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveUpdateBadge } from './updateBadge';

test('shows a blue update dot when an update is available', () => {
  assert.deepEqual(resolveUpdateBadge(true, false), { show: true, tone: 'update' });
});

test('shows an amber restart dot when only a restart is required', () => {
  assert.deepEqual(resolveUpdateBadge(false, true), { show: true, tone: 'restart' });
});

test('update availability takes priority over restart-required', () => {
  assert.deepEqual(resolveUpdateBadge(true, true), { show: true, tone: 'update' });
});

test('hides the badge when nothing is pending', () => {
  assert.deepEqual(resolveUpdateBadge(false, false), { show: false, tone: null });
});
