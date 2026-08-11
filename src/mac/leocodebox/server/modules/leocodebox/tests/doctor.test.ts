import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDoctorReport } from '../doctor.service.js';

const provider = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  target: 'claude',
  name: '家里光猫',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'ab****yz',
  endpointStats: {},
  ...over,
}) as never;

test('runnable CLI is ok with its version; installed-but-broken is fail; missing is warn', () => {
  const report = buildDoctorReport({
    cliTools: [
      { id: 'claude', label: 'Claude Code', installed: true, runnable: true, currentVersion: '2.1.207' },
      { id: 'codex', label: 'Codex', installed: true, runnable: false, error: 'not on PATH' },
      { id: 'grok', label: 'Grok', installed: false, runnable: false },
    ],
    switchProviders: [],
    activeByTarget: {},
  });
  const byId = new Map(report.checks.map((c) => [c.id, c]));
  assert.equal(byId.get('cli:claude')?.status, 'ok');
  assert.match(byId.get('cli:claude')?.detail ?? '', /2\.1\.207/);
  assert.equal(byId.get('cli:codex')?.status, 'fail');
  assert.equal(byId.get('cli:grok')?.status, 'warn');
  assert.deepEqual(report.summary, { ok: 1, warn: 1, fail: 1 });
});

test('active Leoapi node with a key and no failed speed test is ok', () => {
  const report = buildDoctorReport({
    cliTools: [],
    switchProviders: [provider()],
    activeByTarget: { claude: 'p1' },
  });
  assert.equal(report.checks[0].status, 'ok');
  assert.equal(report.summary.ok, 1);
});

test('active Leoapi node without an API key is a fail', () => {
  const report = buildDoctorReport({
    cliTools: [],
    switchProviders: [provider({ apiKey: '' })],
    activeByTarget: { claude: 'p1' },
  });
  assert.equal(report.checks[0].status, 'fail');
  assert.match(report.checks[0].detail, /API Key/);
});

test('active node whose last speed test was unusable is a warn', () => {
  const report = buildDoctorReport({
    cliTools: [],
    switchProviders: [provider({
      endpointStats: { 'https://api.example.com/v1': { schemaVersion: 1, usable: false, latencyMs: 999 } },
    })],
    activeByTarget: { claude: 'p1' },
  });
  assert.equal(report.checks[0].status, 'warn');
  assert.match(report.checks[0].detail, /测速/);
});

test('active target pointing at a missing provider record warns instead of throwing', () => {
  const report = buildDoctorReport({
    cliTools: [],
    switchProviders: [],
    activeByTarget: { claude: 'ghost' },
  });
  assert.equal(report.checks[0].status, 'warn');
});
