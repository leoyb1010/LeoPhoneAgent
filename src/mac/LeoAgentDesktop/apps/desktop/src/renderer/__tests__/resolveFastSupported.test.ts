/**
 * resolveFastSupported —— device-link fast 可用判定收敛的唯一渲染层入口的单测。
 *
 * 锁住三件事:
 *  1. per-provider 分叉:同一 model id 在不同来源 supportsFastMode 不同时,结果跟 providerId 走;
 *  2. **旧被控端回退(no-break 硬约束)**:device 模式 + deviceProviders 空 → 回退拍平 capabilities;
 *  3. agent 级 hasFastMode / agentKind 空 / 模型缺失等边界。
 */
import { describe, it, expect } from 'vitest';

import { buildRegistry, type Catalog, type ProviderView } from '@cindy/model-providers';

import { resolveFastSupported } from '@/lib/providerModels';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';

/** 合成目录:同 id `opus` 在 official(fast=true)与 xd(fast=false)分叉;均 cc。 */
const DIVERGENT: Catalog = {
  version: '1',
  providers: [
    {
      id: 'official',
      name: 'Official',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': { upstream: 'https://a', authStrategy: 'oauth-passthrough' } },
      models: {
        'claude-code': [
          { id: 'opus', name: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: true },
        ],
      },
    },
    {
      id: 'xd',
      name: 'XD',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'managed' },
      routing: { 'claude-code': { upstream: 'https://b', authStrategy: 'gateway-key' } },
      models: {
        'claude-code': [
          { id: 'opus', name: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: false },
        ],
      },
    },
  ],
};

const localViews: ProviderView[] = buildRegistry(DIVERGENT, { official: true, xd: true });

/** 最小 AgentCapabilities 工厂(helper 只读 hasFastMode + availableModels)。 */
function caps(hasFastMode: boolean, flatFast: boolean | undefined): AgentCapabilities {
  return {
    availableModels: [
      { id: 'opus', displayName: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: flatFast },
    ],
    hasFastMode,
    effortLevels: [],
    permissionModes: [],
  };
}

describe('resolveFastSupported', () => {
  const base = {
    deviceId: undefined as string | undefined,
    deviceProviders: [] as ProviderView[],
    localProviders: localViews,
    capabilities: caps(true, true),
    modelId: 'opus',
    agentKind: 'claude-code' as const,
  };

  it('local: per-provider 分叉跟随显式 providerId', () => {
    expect(resolveFastSupported({ ...base, providerId: 'official' })).toBe(true);
    expect(resolveFastSupported({ ...base, providerId: 'xd' })).toBe(false);
  });

  it('local: providerId=null → 走 nativeDefault(cc 默认 xd)→ false', () => {
    // cc 的 nativeDefaultSourceId 优先 xd;xd 的 opus.supportsFastMode=false。
    expect(resolveFastSupported({ ...base, providerId: null })).toBe(false);
  });

  it('device 现代被控端:用 deviceProviders 的 per-provider,忽略 localProviders', () => {
    // localProviders 故意置空以证明走的是 deviceProviders。
    expect(
      resolveFastSupported({
        ...base,
        deviceId: 'dev-1',
        deviceProviders: localViews,
        localProviders: [],
        providerId: 'official',
      }),
    ).toBe(true);
    expect(
      resolveFastSupported({
        ...base,
        deviceId: 'dev-1',
        deviceProviders: localViews,
        localProviders: [],
        providerId: 'xd',
      }),
    ).toBe(false);
  });

  it('device 旧被控端(deviceProviders 空)→ 回退拍平 capabilities(no-break 守卫)', () => {
    expect(
      resolveFastSupported({ ...base, deviceId: 'old-dev', deviceProviders: [], capabilities: caps(true, true), providerId: 'official' }),
    ).toBe(true);
    expect(
      resolveFastSupported({ ...base, deviceId: 'old-dev', deviceProviders: [], capabilities: caps(true, false), providerId: 'official' }),
    ).toBe(false);
  });

  it('agent 级 hasFastMode=false → 恒 false', () => {
    expect(resolveFastSupported({ ...base, capabilities: caps(false, true), providerId: 'official' })).toBe(false);
  });

  it('agentKind=null → false', () => {
    expect(resolveFastSupported({ ...base, agentKind: null, providerId: 'official' })).toBe(false);
  });

  it('device 旧被控端 + 模型不在拍平 caps → false', () => {
    expect(
      resolveFastSupported({ ...base, deviceId: 'old-dev', deviceProviders: [], modelId: 'missing', providerId: 'official' }),
    ).toBe(false);
  });

  it('capabilities=null → false(无 hasFastMode)', () => {
    expect(resolveFastSupported({ ...base, capabilities: null, providerId: 'official' })).toBe(false);
  });
});
