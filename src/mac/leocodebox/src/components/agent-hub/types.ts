import type { LLMProvider } from '../../types/app';

/** Editable payload of an agent profile (everything the user fills in). */
export type AgentProfileDraft = {
  name: string;
  emoji: string;
  provider: LLMProvider;
  model: string;
  effort: string;
  permissionMode: string;
  openingPrompt: string;
  notes: string;
};

/** A stored profile as returned by the API: draft + identity + timestamps. */
export type AgentProfile = AgentProfileDraft & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

/** Standard success envelope used by /api/agent-profiles. */
export type ApiResponse<T> = { success: boolean; data?: T; error?: string; message?: string };
