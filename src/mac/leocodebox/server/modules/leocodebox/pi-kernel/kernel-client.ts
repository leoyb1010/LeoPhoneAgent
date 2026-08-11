/**
 * Real model call for the pi kernel: talks the Anthropic Messages + tool-use
 * protocol against the ACTIVE Leoapi `claude` provider (reusing the provider
 * store — no new credential surface). The pure `parseModelResponse` maps a
 * Messages response into the kernel's ModelTurn and is unit-tested directly.
 */
import { readStore } from '../provider-store.service.js';

import type { CallModel, ModelBlock, ModelTurn, ToolSpec } from './kernel.js';

export type ActiveModel = { baseUrl: string; apiKey: string; model: string; providerName: string };

/** The active `claude` node, or null when nothing is active / it lacks a base URL or key. */
export async function resolveActiveClaudeModel(): Promise<ActiveModel | null> {
  const store = await readStore();
  const activeId = store.activeByTarget?.claude;
  const provider = activeId ? store.providers.find((item) => item.id === activeId) : undefined;
  if (!provider?.baseUrl || !provider.apiKey) return null;
  return {
    baseUrl: provider.baseUrl.replace(/\/+$/, ''),
    apiKey: provider.apiKey,
    model: provider.model || 'claude-sonnet-4-5',
    providerName: provider.name || provider.id,
  };
}

/** Anthropic puts the messages endpoint at /v1/messages; tolerate a baseUrl already ending in /v1. */
function messagesUrl(baseUrl: string): string {
  return /\/v1$/i.test(baseUrl) ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
}

/** Pure: map a Messages API response body into a ModelTurn. Never throws. */
export function parseModelResponse(json: unknown): ModelTurn {
  const record = json && typeof json === 'object' ? json as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const blocks: ModelBlock[] = [];
  for (const raw of content) {
    const block = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: String(block.id || ''),
        name: String(block.name || ''),
        input: block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {},
      });
    }
  }
  return { blocks, stopReason: typeof record.stop_reason === 'string' ? record.stop_reason : null };
}

/** Build a CallModel bound to a provider + system prompt + tool specs. */
export function createAnthropicCallModel(cfg: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  tools: ToolSpec[];
  maxTokens?: number;
  timeoutMs?: number;
}): CallModel {
  return async (messages) => {
    const response = await fetch(messagesUrl(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        authorization: `Bearer ${cfg.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? 2048,
        system: cfg.system,
        tools: cfg.tools,
        messages,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`model HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return parseModelResponse(await response.json());
  };
}
