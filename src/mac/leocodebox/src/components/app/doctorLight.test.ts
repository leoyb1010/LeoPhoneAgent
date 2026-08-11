import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDoctorTone } from './doctorLight';

test('fail takes priority (red)', () => {
  assert.equal(resolveDoctorTone({ ok: 3, warn: 1, fail: 1 }), 'fail');
});

test('warn without fail is amber', () => {
  assert.equal(resolveDoctorTone({ ok: 3, warn: 2, fail: 0 }), 'warn');
});

test('all-ok is green', () => {
  assert.equal(resolveDoctorTone({ ok: 5, warn: 0, fail: 0 }), 'ok');
});

test('missing summary defaults to ok (no alarming light before first fetch)', () => {
  assert.equal(resolveDoctorTone(null), 'ok');
  assert.equal(resolveDoctorTone(undefined), 'ok');
});
