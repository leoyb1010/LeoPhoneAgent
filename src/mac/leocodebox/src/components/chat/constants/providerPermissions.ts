import type { LLMProvider } from '../../../types/app';
import type { PermissionMode } from '../types/types';

/**
 * 各 Agent 支持的权限模式(静态兜底表)。
 *
 * 权威来源是后端的 `GET /api/providers/capabilities`;这份镜像用于两处
 * capabilities 还没到手、或者拿不到能力矩阵的场合:
 *   1. 会话内的权限选择器首屏;
 *   2. 指挥条 —— 它在会话之外,压根不持有能力矩阵。
 *
 * 指挥条必须用上它:以前那里无条件列出全部五档,而 Codex 只吃三档,
 * 选「计划模式」会在发送时被静默降级回该 Agent 的默认档 —— 芯片上写着计划模式,
 * 跑起来却不是,这也是一种"选了不生效"。
 */
export const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  grok: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};
