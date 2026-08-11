import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSafetyGate, type SafetyReport } from './contentSafety';

const report = (
  highestSeverity: SafetyReport['highestSeverity'],
  findings: number,
): SafetyReport => ({
  highestSeverity,
  findings: Array.from({ length: findings }, () => ({
    severity: highestSeverity ?? 'low',
    category: 'x',
    rule: 'x',
    line: 1,
    snippet: 'x',
  })),
});

test('no report or no findings is clean and non-blocking', () => {
  assert.deepEqual(resolveSafetyGate(null), { tone: 'clean', blocking: false, count: 0 });
  assert.deepEqual(resolveSafetyGate(report(null, 0)), { tone: 'clean', blocking: false, count: 0 });
});

test('high severity blocks (red)', () => {
  const gate = resolveSafetyGate(report('high', 2));
  assert.equal(gate.tone, 'high');
  assert.equal(gate.blocking, true);
  assert.equal(gate.count, 2);
});

test('medium severity warns but does not block (yellow)', () => {
  assert.deepEqual(resolveSafetyGate(report('medium', 1)), { tone: 'medium', blocking: false, count: 1 });
});

test('low-only findings still surface as a non-blocking note', () => {
  const gate = resolveSafetyGate(report('low', 3));
  assert.equal(gate.tone, 'medium');
  assert.equal(gate.blocking, false);
  assert.equal(gate.count, 3);
});
