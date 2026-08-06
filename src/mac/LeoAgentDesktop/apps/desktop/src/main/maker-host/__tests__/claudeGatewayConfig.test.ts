import { describe, expect, it } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';
import type { Catalog } from '@cindy/model-providers';

import {
  anthropicCatalogModelIds,
  isAnthropicWireModel,
} from '../claude-gateway-config.js';

describe('isAnthropicWireModel', () => {
  // toSdkModelString 改写后的真实 wire string(对照 claude-code/index.ts:101-117)
  const anthropic = [
    'claude-opus-4-8[1m]',
    'claude-opus-4-7[1m]',
    'claude-opus-4-6[1m]',
    'claude-fable-5[1m]',
    'sonnet[1m]',
    'claude-haiku-4-5-20251001',
    // 防御:裸别名也算 Anthropic
    'opus',
    'haiku',
    'fable',
  ];
  const gateway = [
    'gpt-5.5[1m]',
    'gpt-5.4[1m]',
    'codex/gpt-5.5[1m]',
    'deepseek/deepseek-v4-pro[1m]',
    'deepseek/deepseek-v4-flash[1m]',
    'z-ai/glm-5.2[1m]',
    'qwen/qwen3.7-max',
    'kimi-k2',
    'gemini-2.5-pro',
  ];

  it.each(anthropic)('%s → Anthropic 原生', (m) => {
    expect(isAnthropicWireModel(m)).toBe(true);
  });
  it.each(gateway)('%s → provider 路由(gateway)', (m) => {
    expect(isAnthropicWireModel(m)).toBe(false);
  });
  it('大小写不敏感 + trim', () => {
    expect(isAnthropicWireModel('  Claude-Opus-4-8[1m]  ')).toBe(true);
    expect(isAnthropicWireModel('SONNET[1m]')).toBe(true);
  });
  it('空串 → false', () => {
    expect(isAnthropicWireModel('')).toBe(false);
    expect(isAnthropicWireModel('   ')).toBe(false);
  });

  // ── 目录集合判据:anthropic 供应商名下的模型可直连,新家族名不再依赖前缀发版 ──
  describe('catalog-driven set', () => {
    const ids = new Set(['claude-opus-4-8', 'claude-haiku-4-5', 'mythos-1']);

    it('目录里的新家族名(无已知前缀)→ 允许直连,含 [1m] 变体', () => {
      expect(isAnthropicWireModel('mythos-1', ids)).toBe(true);
      expect(isAnthropicWireModel('mythos-1[1m]', ids)).toBe(true);
      expect(isAnthropicWireModel('MYTHOS-1[1m]', ids)).toBe(true);
    });

    it('不传目录集合时新家族名仍是 false(纯前缀退化,fail-safe)', () => {
      expect(isAnthropicWireModel('mythos-1')).toBe(false);
      expect(isAnthropicWireModel('mythos-1[1m]')).toBe(false);
    });

    it('日期版本号 wire 串归一化回目录 id', () => {
      // 前缀本来就命中 haiku;这里专门用去掉前缀语义的集合验证归一化路径
      expect(isAnthropicWireModel('claude-haiku-4-5-20251001', new Set(['claude-haiku-4-5']))).toBe(true);
    });

    it('gateway 模型不因传入目录集合而误判', () => {
      for (const m of gateway) {
        expect(isAnthropicWireModel(m, ids)).toBe(false);
      }
    });
  });
});

describe('anthropicCatalogModelIds', () => {
  const catalog = {
    version: '1',
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: { 'claude-code': { upstream: 'https://api.anthropic.com', authStrategy: 'oauth-passthrough' } },
        models: {
          'claude-code': [
            { id: 'claude-opus-4-8', name: 'Opus 4.8', contextWindow: 1_000_000, efforts: [], defaultEffort: null, status: 'active' },
            { id: 'mythos-1', name: 'Mythos 1', contextWindow: 1_000_000, efforts: [], defaultEffort: null, status: 'active' },
          ],
          codex: [
            { id: 'mythos-agentic', name: 'Mythos Agentic', contextWindow: 1_000_000, efforts: [], defaultEffort: null, status: 'active' },
          ],
        },
      },
      {
        id: 'xd',
        name: 'XD Gateway',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'managed' },
        routing: { 'claude-code': { upstream: XD_GATEWAY_BASE_URL, authStrategy: 'gateway-key' } },
        models: {
          'claude-code': [
            { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, efforts: [], defaultEffort: null, status: 'active' },
          ],
        },
      },
    ],
  } as unknown as Catalog;

  it('收 anthropic 供应商全部 agent 的模型;其它供应商(xd 的 gpt)不进集合', () => {
    const ids = anthropicCatalogModelIds(catalog);
    expect(ids.has('claude-opus-4-8')).toBe(true);
    expect(ids.has('mythos-1')).toBe(true);
    // 供应商级判据:非 claude-code agent 下的条目同样计入
    expect(ids.has('mythos-agentic')).toBe(true);
    expect(ids.has('gpt-5.5')).toBe(false);
  });

  it('同一 catalog 引用返回 memo 的同一集合(热路径 O(1))', () => {
    expect(anthropicCatalogModelIds(catalog)).toBe(anthropicCatalogModelIds(catalog));
  });
});

// 退役全局鉴权开关后,per-model/默认路由决策改由 catalog 描述符 + spawn-aware 默认承载,
// 对应的逐字段 no-break 基线断言见 providerRoute.test.ts(buildRouteDecision 的字面量锁定)。
// 本文件只保留与之解耦的纯分类器 isAnthropicWireModel 测试。
