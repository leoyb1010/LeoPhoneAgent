/**
 * main/im/feishu/index.ts
 * ---------------------------------------------------------------------------
 * Wire the feishu IM channel up to the shared orchestrator.
 *
 * Called once at app ready. Returns nothing — subscriptions live for the
 * process lifetime; they auto-unsubscribe on process exit.
 *
 * The caller passes an ImOrchestratorConfig that holds all IM-layer product
 * decisions (agent kind, default model, default permission mode, effort
 * overrides) — 编排逻辑全部在 im/shared/, 本文件只组装 feishu adapter。
 */

import type { FeishuIM } from '@cindy/im';

import { createImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildFeishuAdapter } from './adapter';

/** 兼容别名 — 历史命名, 形状即 ImOrchestratorConfig。 */
export type FeishuOrchestratorConfig = ImOrchestratorConfig;

export function wireFeishuOrchestrator(
  feishuIm: FeishuIM,
  config: ImOrchestratorConfig,
): void {
  createImOrchestrator(buildFeishuAdapter(feishuIm, config));
}
