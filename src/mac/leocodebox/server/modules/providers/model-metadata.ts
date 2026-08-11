/** Provider model metadata shared by usage reporting and runtime adapters. */
import { arsenalContextWindow } from '@/shared/model-arsenal.js';

const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  claude: 200_000,
  'claude-3-5': 200_000,
  'claude-3-7': 200_000,
  sonnet: 200_000,
  opus: 200_000,
  haiku: 200_000,
  codex: 200_000,
  'gpt-5': 400_000,
  'gpt-4': 128_000,
  grok: 131_072,
  cursor: 200_000,
  opencode: 200_000,
};

export function getModelContextWindow(provider: string, model?: string | null): number {
  const fromArsenal = arsenalContextWindow(provider, model);
  if (fromArsenal) return fromArsenal;
  const key = String(model || provider).toLowerCase();
  const match = Object.entries(DEFAULT_CONTEXT_WINDOWS).find(([name]) => key.includes(name));
  return match?.[1] ?? DEFAULT_CONTEXT_WINDOWS[provider] ?? 200_000;
}
