import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { armParentWatchdog, isParentAlive } from '@/browser-use-mcp-watchdog.js';

test('the current process counts as alive', () => {
  assert.equal(isParentAlive(process.pid), true);
});

test('init/invalid pids are treated as dead', () => {
  for (const pid of [1, 0, -1, Number.NaN, 999999999]) {
    assert.equal(isParentAlive(pid), false);
  }
});

test('a pid flips to dead after the process exits', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((resolve) => child.once('spawn', resolve));
  assert.equal(isParentAlive(child.pid!), true);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the OS reap it
  assert.equal(isParentAlive(child.pid!), false);
});

test('armParentWatchdog is a no-op when already orphaned (ppid <= 1)', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'ppid');
  Object.defineProperty(process, 'ppid', { value: 1, configurable: true });
  try {
    let exited = false;
    const stop = armParentWatchdog(() => { exited = true; });
    stop();
    assert.equal(exited, false, 'should not exit when there is no real parent');
  } finally {
    if (original) Object.defineProperty(process, 'ppid', original);
  }
});

test('armParentWatchdog exits once the tracked parent disappears', async () => {
  // Simulate a live parent, then a dead one, via a fake ppid.
  const original = Object.getOwnPropertyDescriptor(process, 'ppid');
  Object.defineProperty(process, 'ppid', { value: process.pid, configurable: true }); // self = alive
  try {
    let exitCode: number | null = null;
    const stop = armParentWatchdog((code) => { exitCode = code; }, 10);
    // While ppid points at a live pid (ourselves) and is unchanged, no exit.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(exitCode, null);
    // Now flip ppid to a dead pid → next tick should trigger exit(0).
    Object.defineProperty(process, 'ppid', { value: 999999999, configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();
    assert.equal(exitCode, 0);
  } finally {
    if (original) Object.defineProperty(process, 'ppid', original);
  }
});
