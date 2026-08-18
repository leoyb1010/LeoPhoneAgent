import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '../../utils/apiClient';
import type { LLMProvider } from '../../types/app';
import type { CliToolStatus } from '../settings/view/tabs/agents-settings/CliToolsSection';

type CliStatusResponse = { success: boolean; tools?: CliToolStatus[] };

export type LocalAgent = {
  provider: LLMProvider;
  label: string;
  /** 「v2.1.4 · 已连接」这类副标题,直接进 Agent 下拉菜单。 */
  status: string;
  installed: boolean;
  updateAvailable: boolean;
};

/** CLI id → 聊天侧的 provider id。cursor 的 CLI 叫 cursor-agent。 */
const PROVIDER_BY_CLI: Record<string, LLMProvider> = {
  claude: 'claude',
  codex: 'codex',
  'cursor-agent': 'cursor',
  cursor: 'cursor',
  grok: 'grok',
  opencode: 'opencode',
};

/**
 * 本机智能体清单 —— 指挥条的 Agent 下拉直接消费。
 *
 * 复用设置页「本机智能体」那条 /api/leocodebox/cli/status,不另起数据源:
 * 版本号、更新提示、登录态在两处必须是同一份事实。
 */
export function useLocalAgents() {
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const payload = (await apiRequest('/api/leocodebox/cli/status')) as CliStatusResponse;
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      setAgents(
        tools
          .map((tool): LocalAgent | null => {
            const provider = PROVIDER_BY_CLI[tool.id];
            if (!provider) return null;
            const version = tool.currentVersion ? `v${tool.currentVersion.replace(/^v/, '')}` : '';
            const state = !tool.installed
              ? '未安装'
              : tool.updateAvailable
                ? '有新版本'
                : tool.runnable
                  ? '已连接'
                  : '不可运行';
            return {
              provider,
              label: tool.label,
              status: [version, state].filter(Boolean).join(' · '),
              installed: tool.installed,
              updateAvailable: Boolean(tool.updateAvailable),
            };
          })
          .filter((agent): agent is LocalAgent => Boolean(agent)),
      );
    } catch {
      // 探测失败时保持上一份清单,指挥条不能因为一次网络抖动就空掉。
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agents, loaded, refresh };
}
