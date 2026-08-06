import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileAgentCapabilities } from '@/session/agentCapabilities';

beforeEach(() => {
  vi.resetModules();
});

function capabilities(label: string): MobileAgentCapabilities {
  return {
    availableModels: [{
      id: label,
      label,
      efforts: [],
      effortDisplayNames: {},
      defaultEffort: null,
      supportsFastMode: false,
    }],
    hasFastMode: false,
    effortLevels: [],
    permissionModes: [],
    planModeSupported: false,
  };
}

describe('agentCapabilitiesCache', () => {
  it('当前代提交会按 deviceId + agentKind 通知对应订阅者', async () => {
    const mod = await import('@/session/agentCapabilitiesCache');
    const claudeListener = vi.fn();
    const codexListener = vi.fn();
    mod.subscribeAgentCapabilities('dev-1', 'claude-code', claudeListener);
    mod.subscribeAgentCapabilities('dev-1', 'codex', codexListener);
    const generation = mod.getAgentCapabilitiesGeneration('dev-1');

    expect(mod.commitAgentCapabilities(
      'dev-1',
      'claude-code',
      generation,
      capabilities('claude-fresh'),
    )).toBe(true);
    expect(mod.commitAgentCapabilities(
      'dev-1',
      'codex',
      generation,
      capabilities('codex-fresh'),
    )).toBe(true);

    expect(claudeListener).toHaveBeenCalledTimes(1);
    expect(codexListener).toHaveBeenCalledTimes(1);
    expect(mod.getCachedAgentCapabilities(
      mod.buildAgentCapabilitiesCacheKey('dev-1', 'codex'),
    )?.availableModels[0].id).toBe('codex-fresh');
  });

  it('revision 后新代先完成、旧代后完成时只通知并保留新快照', async () => {
    const mod = await import('@/session/agentCapabilitiesCache');
    const listener = vi.fn();
    mod.subscribeAgentCapabilities('dev-1', 'codex', listener);
    const staleGeneration = mod.getAgentCapabilitiesGeneration('dev-1');
    mod.evictAgentCapabilitiesForDevice('dev-1');
    const freshGeneration = mod.getAgentCapabilitiesGeneration('dev-1');

    expect(mod.commitAgentCapabilities(
      'dev-1',
      'codex',
      freshGeneration,
      capabilities('fresh'),
    )).toBe(true);
    expect(mod.commitAgentCapabilities(
      'dev-1',
      'codex',
      staleGeneration,
      capabilities('stale'),
    )).toBe(false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(capabilities('fresh'));
    expect(mod.getCachedAgentCapabilities(
      mod.buildAgentCapabilitiesCacheKey('dev-1', 'codex'),
    )?.availableModels[0].id).toBe('fresh');
  });

  it('登出 reset 会作废已在途代际并清空缓存', async () => {
    const mod = await import('@/session/agentCapabilitiesCache');
    const generation = mod.getAgentCapabilitiesGeneration('dev-1');
    mod.commitAgentCapabilities('dev-1', 'codex', generation, capabilities('before-logout'));

    mod.resetAgentCapabilitiesCache();

    expect(mod.commitAgentCapabilities(
      'dev-1',
      'codex',
      generation,
      capabilities('stale-after-logout'),
    )).toBe(false);
    expect(mod.getCachedAgentCapabilities(
      mod.buildAgentCapabilitiesCacheKey('dev-1', 'codex'),
    )).toBeNull();
  });
});
