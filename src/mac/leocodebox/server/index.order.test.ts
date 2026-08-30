import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('public auth routes are mounted before the broad authenticated fleet router', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const publicAuth = source.indexOf("app.use('/api/auth', authRoutes)");
  const fleetBoundary = source.indexOf("app.use('/api', authenticateToken, fleetRoutes)");
  assert.notEqual(publicAuth, -1);
  assert.notEqual(fleetBoundary, -1);
  assert.ok(publicAuth < fleetBoundary, 'fleet auth must not intercept login or local bootstrap exchange');
});
