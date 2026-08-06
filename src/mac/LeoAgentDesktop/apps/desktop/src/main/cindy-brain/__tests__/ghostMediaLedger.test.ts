/**
 * ghostMediaLedger 单测:署名记账 / 收口取账即删 / 未署名不记 / 去重与上限。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetGhostMediaLedgerForTest,
  drainGhostCallMedia,
  recordGhostCallMedia,
} from '../ghostMediaLedger';

const URL_A = `cindy-media://blobs/${'a'.repeat(64)}.png`;
const URL_B = `cindy-media://blobs/${'b'.repeat(64)}.png`;

beforeEach(() => {
  _resetGhostMediaLedgerForTest();
});

describe('ghostMediaLedger', () => {
  it('署名记账 → drain 取回并清账,二次 drain 为空', () => {
    recordGhostCallMedia('g1', 'call-1', URL_A);
    recordGhostCallMedia('g1', 'call-1', URL_B);
    expect(drainGhostCallMedia('g1', 'call-1')).toEqual([URL_A, URL_B]);
    expect(drainGhostCallMedia('g1', 'call-1')).toEqual([]);
  });

  it('未署名(callId 缺省)不记账', () => {
    recordGhostCallMedia('g1', undefined, URL_A);
    expect(drainGhostCallMedia('g1', 'call-1')).toEqual([]);
  });

  it('按 ghostId+callId 隔离,互不串账', () => {
    recordGhostCallMedia('g1', 'call-1', URL_A);
    recordGhostCallMedia('g2', 'call-1', URL_B);
    recordGhostCallMedia('g1', 'call-2', URL_B);
    expect(drainGhostCallMedia('g1', 'call-1')).toEqual([URL_A]);
    expect(drainGhostCallMedia('g2', 'call-1')).toEqual([URL_B]);
    expect(drainGhostCallMedia('g1', 'call-2')).toEqual([URL_B]);
  });

  it('同 URL 去重,单调用上限 32 条', () => {
    recordGhostCallMedia('g1', 'call-1', URL_A);
    recordGhostCallMedia('g1', 'call-1', URL_A);
    for (let i = 0; i < 40; i++) {
      recordGhostCallMedia('g1', 'call-1', `cindy-media://blobs/${String(i).padStart(64, '0')}.png`);
    }
    const drained = drainGhostCallMedia('g1', 'call-1');
    expect(drained[0]).toBe(URL_A);
    expect(drained.length).toBe(32);
    expect(new Set(drained).size).toBe(32);
  });
});
