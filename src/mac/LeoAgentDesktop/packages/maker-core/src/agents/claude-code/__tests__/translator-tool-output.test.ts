import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    pendingApiError: null,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

function createCtx() {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'claude-sonnet-4.5',
    getEffort: () => 'medium',
    getPermissionMode: () => 'auto',
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker: new UsageTracker(),
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('Claude Code translator tool output normalization', () => {
  it('strips terminal control sequences from Bash tool_result content', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_ansi',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_ansi',
              content: '\u001B[7mCLAUDE.md\u001B[0m\n\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007',
            },
          ],
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const full = events.find((event) => event.type === 'tool_result_full');
    expect(full).toMatchObject({
      data: {
        toolUseId: 'toolu_ansi',
        fullText: 'CLAUDE.md\nlink',
      },
      source: 'claude-code',
    });
  });

  it('preserves terminal control sequences from non-terminal tool_result content', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read',
              name: 'Read',
              input: { file_path: 'ansi-fixture.txt' },
            },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read',
              content: 'literal \u001B[7mcontent\u001B[0m',
            },
          ],
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const full = events.find((event) => event.type === 'tool_result_full');
    expect(full).toMatchObject({
      data: {
        toolUseId: 'toolu_read',
        fullText: 'literal \u001B[7mcontent\u001B[0m',
      },
      source: 'claude-code',
    });
  });

  it('strips terminal control sequences from PowerShell tool_result content', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_pwsh',
              name: 'PowerShell',
              input: { command: 'Get-Content package.json' },
            },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_pwsh',
              content: '\u001B[7mpackage.json\u001B[0m',
            },
          ],
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const full = events.find((event) => event.type === 'tool_result_full');
    expect(full).toMatchObject({
      data: {
        toolUseId: 'toolu_pwsh',
        fullText: 'package.json',
      },
      source: 'claude-code',
    });
  });
});
