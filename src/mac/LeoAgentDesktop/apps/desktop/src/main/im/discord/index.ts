/**
 * main/im/discord/index.ts
 * ---------------------------------------------------------------------------
 * Wire the Discord IM channel up to the shared orchestrator.
 */

import type { DiscordIM } from '@cindy/im';

import { createImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildDiscordAdapter } from './adapter';
import { registerDiscordSessionAuthIpc } from './sessionAuth';

export function wireDiscordOrchestrator(discordIm: DiscordIM, config: ImOrchestratorConfig): void {
  createImOrchestrator(buildDiscordAdapter(discordIm, config));
  registerDiscordSessionAuthIpc(config);
}
