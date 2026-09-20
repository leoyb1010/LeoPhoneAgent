import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { netpathShift, netpathState } from './netpath.js';

test('能认出换了网络，不断网不算', () => {
  const wifi = netpathState({ en0: [{ address: '10.0.0.8', family: 'IPv4', internal: false }] });
  const cell = netpathState({ en0: [{ address: '172.20.10.2', family: 'IPv4', internal: false }] });
  const none = netpathState({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] });
  assert.equal(wifi.key, '10.0.0.8');
  assert.equal(netpathShift(wifi, cell), 'changed');
  assert.equal(netpathShift(wifi, wifi), null);
  assert.equal(netpathShift(wifi, none), null);
  assert.equal(netpathShift(none, wifi), null);
  assert.deepEqual(netpathState(null), { key: '', can: false, addrs: [] });
});

test('装机壳挂上了换网提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:netpath/);
  assert.match(main, /tickNetpath|networkInterfaces/);
  assert.match(preload, /onNetpathChanged/);
  assert.doesNotMatch(main, /new Tray\(/);
});
