/**
 * deviceModelMetaCache 单测:命中 / inflight 去重 / 失败降级(不缓存、不抛)/ 空表收敛 null /
 * evict 代际作废 / clearAll。纯逻辑,node env。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllDeviceModelMeta,
  evictDeviceModelMeta,
  fetchDeviceApiKeyStatus,
  fetchDeviceModelPricing,
  getCachedDeviceApiKeyStatus,
  getCachedDeviceModelPricing,
} from '@/device-link/deviceModelMetaCache';

const PRICING = { 'gpt-5.5': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 } };

describe('deviceModelMetaCache', () => {
  beforeEach(() => {
    clearAllDeviceModelMeta();
  });

  it('单价表:命中缓存不再 fetch;空表 / 非法形状收敛为 null', async () => {
    const fetcher = vi.fn().mockResolvedValue(PRICING);
    await expect(fetchDeviceModelPricing('devA', fetcher)).resolves.toEqual(PRICING);
    await expect(fetchDeviceModelPricing('devA', fetcher)).resolves.toEqual(PRICING);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(getCachedDeviceModelPricing('devA')).toEqual(PRICING);

    await expect(fetchDeviceModelPricing('devB', vi.fn().mockResolvedValue({}))).resolves.toBeNull();
    expect(getCachedDeviceModelPricing('devB')).toBeNull(); // 空表也缓存(合法结果,无价可示)
  });

  it('key presence:present/absent 映射;失败 → undefined 且不缓存(下次重试)', async () => {
    await expect(
      fetchDeviceApiKeyStatus('devA', vi.fn().mockResolvedValue({ present: true })),
    ).resolves.toBe('present');
    expect(getCachedDeviceApiKeyStatus('devA')).toBe('present');

    const failing = vi.fn().mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
    await expect(fetchDeviceApiKeyStatus('devB', failing)).resolves.toBeUndefined();
    expect(getCachedDeviceApiKeyStatus('devB')).toBeUndefined();
    // 失败未缓存 → 再次调用会重试。
    await expect(
      fetchDeviceApiKeyStatus('devB', vi.fn().mockResolvedValue({ present: false })),
    ).resolves.toBe('absent');
  });

  it('inflight 去重:并发两次只 fetch 一次', async () => {
    let release: (v: { present: boolean }) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<{ present: boolean }>((r) => { release = r; }));
    const p1 = fetchDeviceApiKeyStatus('devA', fetcher);
    const p2 = fetchDeviceApiKeyStatus('devA', fetcher);
    release({ present: true });
    await expect(p1).resolves.toBe('present');
    await expect(p2).resolves.toBe('present');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('evict:代际作废在途 fetch 的回写(旧数据不落缓存)', async () => {
    let release: (v: typeof PRICING) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<typeof PRICING>((r) => { release = r; }));
    const p = fetchDeviceModelPricing('devA', fetcher);
    evictDeviceModelMeta('devA');
    release(PRICING);
    await p;
    expect(getCachedDeviceModelPricing('devA')).toBeUndefined();
  });

  it('clearAll:清空全部设备并作废在途', async () => {
    await fetchDeviceApiKeyStatus('devA', vi.fn().mockResolvedValue({ present: true }));
    await fetchDeviceModelPricing('devB', vi.fn().mockResolvedValue(PRICING));
    clearAllDeviceModelMeta();
    expect(getCachedDeviceApiKeyStatus('devA')).toBeUndefined();
    expect(getCachedDeviceModelPricing('devB')).toBeUndefined();
  });
});
