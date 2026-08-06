/**
 * Setup gate dialog description formatting coverage (missing vs reauth wording).
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { describe, expect, it } from 'vitest';

import type { GhostSetupStatus } from '../../../../shared/ghost';
import { formatSetupGateDescription } from '../lib/ghostSetupGateModel';

/** 假翻译器:分隔符返回真实中文值,正文 key 返回「key + 插值」便于断言。 */
const t = (key: string, options?: Record<string, unknown>) => {
  if (key === 'settings.ghosts.setupGate.anySeparator') return ' 或 ';
  if (key === 'settings.ghosts.setupGate.groupSeparator') return '、';
  return `${key}:${String(options?.items ?? '')}`;
};

describe('formatSetupGateDescription', () => {
  it('缺失组:组内用「或」、组间用顿号拼接,走 descriptionMissing', () => {
    const status: GhostSetupStatus = {
      ready: false,
      missingGroups: [
        [
          { ref: 'secret:brave_api_key', label: 'Brave API Key', kind: 'key' },
          { ref: 'secret:tavily_api_key', label: 'Tavily API Key', kind: 'key' },
        ],
        [{ ref: 'connection:gitlab_conn', label: 'GitLab 实例', kind: 'connection' }],
      ],
      reauth: [],
    };
    expect(formatSetupGateDescription(status, t)).toBe(
      'settings.ghosts.setupGate.descriptionMissing:Brave API Key 或 Tavily API Key、GitLab 实例',
    );
  });

  it('缺失与过期并存:过期条目并入缺失清单,仍走 descriptionMissing', () => {
    const status: GhostSetupStatus = {
      ready: false,
      missingGroups: [[{ ref: 'secret:api_key', label: 'API Key', kind: 'key' }]],
      reauth: [{ ref: 'secret:google_account', label: 'Google 账号', kind: 'oauth' }],
    };
    expect(formatSetupGateDescription(status, t)).toBe(
      'settings.ghosts.setupGate.descriptionMissing:API Key、Google 账号',
    );
  });

  it('仅账号过期:走 descriptionReauth「重新连接」话术', () => {
    const status: GhostSetupStatus = {
      ready: false,
      missingGroups: [],
      reauth: [{ ref: 'secret:google_account', label: 'Google 账号', kind: 'oauth' }],
    };
    expect(formatSetupGateDescription(status, t)).toBe(
      'settings.ghosts.setupGate.descriptionReauth:Google 账号',
    );
  });
});
