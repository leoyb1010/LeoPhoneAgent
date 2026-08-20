import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessForMachine, remoteLaunchFields, type FleetMachine } from './useFleetSnapshot';

function machine(overrides: Partial<FleetMachine>): FleetMachine {
  return { name: 'remote', online: true, reachable: true, activeCount: 0, sessions: [], ...overrides };
}

test('Android and Harmony bodies always use the minis harness', () => {
  assert.equal(harnessForMachine(machine({ platform: 'android', server: 'minis' }), 'codex'), 'minis');
  assert.equal(harnessForMachine(machine({ platform: 'harmony' }), 'claude'), 'minis');
});

test('Mac machines keep the explicitly selected coding harness', () => {
  assert.equal(harnessForMachine(machine({ platform: 'leoagent', server: 'leocodebox' }), 'cursor'), 'cursor');
});

test('Android/Harmony launches omit the Mac project cwd', () => {
  const android = remoteLaunchFields(
    machine({ platform: 'android', server: 'minis' }),
    'codex',
    { cwd: '/Users/leo/leocodebox', thinking: 'high' },
  );
  assert.deepEqual(android, { harness: 'minis', thinking: 'high' });

  const mac = remoteLaunchFields(
    machine({ platform: 'leoagent', server: 'leocodebox' }),
    'cursor',
    { cwd: '/Users/leo/leocodebox', thinking: 'default' },
  );
  assert.deepEqual(mac, { harness: 'cursor', cwd: '/Users/leo/leocodebox', thinking: undefined });
});
