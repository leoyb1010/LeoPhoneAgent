import assert from 'node:assert/strict';
import test from 'node:test';

import { harnessForMachine, type FleetMachine } from './useFleetSnapshot';

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
