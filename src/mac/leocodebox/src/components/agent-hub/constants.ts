import type { LLMProvider } from '../../types/app';

import type { AgentProfileDraft } from './types';

export const HUB_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'grok'];

export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
};

/** Per-provider default model id (matches useChatProviderState's fallbacks). */
export const PROVIDER_DEFAULT_MODEL: Record<LLMProvider, string> = {
  claude: 'default',
  cursor: 'gpt-5.3-codex',
  codex: 'gpt-5.4',
  opencode: 'anthropic/claude-sonnet-4-5',
  grok: 'grok-4.5',
};

/** Permission modes each provider accepts (mirrors the composer's fallback matrix). */
export const PROVIDER_PERMISSION_MODES: Record<LLMProvider, string[]> = {
  claude: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
  cursor: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  codex: ['default', 'acceptEdits', 'bypassPermissions'],
  opencode: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  grok: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
};

/** Effort options per provider; 'default' is always allowed. Claude/cursor share none-effort semantics. */
export const PROVIDER_EFFORT_VALUES: Record<LLMProvider, string[]> = {
  claude: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  cursor: ['default'],
  codex: ['default', 'low', 'medium', 'high', 'xhigh'],
  opencode: ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['default', 'low', 'medium', 'high'],
};

export const PERMISSION_MODE_LABELS: Record<string, string> = {
  default: '默认',
  auto: '自动',
  acceptEdits: '接受编辑',
  bypassPermissions: '跳过权限',
  plan: '计划模式',
};

/** Emoji palette for quick profile identity picking. */
export const PROFILE_EMOJI_CHOICES = [
  '🤖', '🔍', '⚡', '🧭', '🛠️', '📝', '🧪', '🚀', '🎯', '🧠', '🐛', '📊', '🔐', '🎨', '📦', '🧩',
];

export const emptyDraft = (): AgentProfileDraft => ({
  name: '',
  emoji: '🤖',
  provider: 'claude',
  model: '',
  effort: 'default',
  permissionMode: 'default',
  openingPrompt: '',
  notes: '',
});
