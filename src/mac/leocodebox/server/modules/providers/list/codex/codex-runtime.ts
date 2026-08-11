/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-runtime.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 */

import { Codex } from '@openai/codex-sdk';
import type { ApprovalMode, ModelReasoningEffort, SandboxMode, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';

import { buildCodexInputItems, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/services/notification-orchestrator.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { applyActiveSwitchEnv } from '@/modules/leocodebox/index.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

import { ensureFallbackCodexBinary } from './codex-fallback.service.js';


type RuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: number | null;
  isSSEStreamWriter?: boolean;
  isWebSocketWriter?: boolean;
};
type CodexRuntimeOptions = {
  sessionId?: string | null;
  appSessionId?: string | null;
  abortSignal?: AbortSignal;
  sessionSummary?: string | null;
  cwd?: string | null;
  projectPath?: string | null;
  model?: string | null;
  effort?: string | null;
  images?: unknown[];
  permissionMode?: string;
};
type CodexRunState = { thread: Thread | null; codex: Codex | null; status: 'running' | 'aborted' | 'completed'; abortController: AbortController; startedAt: string };
type ActiveCodexSession = { id: string; status: CodexRunState['status']; startedAt: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

const activeCodexSessions = new Map<string, CodexRunState>();

function readUsageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCodexTokenBudget(event: unknown) {
  const source = asRecord(event);
  const payload = asRecord(source.payload);
  const eventUsage = asRecord(source.usage);
  const info = asRecord(source.info || asRecord(payload).info || eventUsage.info);
  const usage = asRecord(info.total_token_usage || eventUsage.total_token_usage || source.usage);
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  return {
    used,
    total: readUsageNumber(info.model_context_window || eventUsage.model_context_window) || 200000,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event: ThreadEvent) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: 'unknown',
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: 'unknown',
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode: string | undefined): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command: string, options: CodexRuntimeOptions = {}, writer: object): Promise<void> {
  const runStartedAtMs = Date.now();
  const ws = writer as RuntimeWriter;
  const {
    sessionId,
    appSessionId,
    abortSignal,
    sessionSummary,
    cwd,
    projectPath,
    model,
    effort,
    images,
    permissionMode = 'default'
  } = options;

  const resolvedModel = await providerModelsService.resolveResumeModel(
    'codex',
    appSessionId || sessionId || undefined,
    model || undefined,
  );

  const workingDirectory = cwd || projectPath || process.cwd();
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const catalog = (await providerModelsService.getProviderModels('codex')).models;
  const selectedModel = catalog.OPTIONS.find((option) => option.value === resolvedModel) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  const resolvedEffort = typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;

  let codex: Codex;
  let thread: Thread;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let terminalFailure: unknown = null;
  const abortController = new AbortController();
  const runState: CodexRunState = {
    thread: null,
    codex: null,
    status: 'running',
    abortController,
    startedAt: new Date().toISOString()
  };
  const abortFromGateway = () => {
    runState.status = 'aborted';
    abortController.abort();
  };
  if (abortSignal?.aborted) {
    abortFromGateway();
    return;
  }
  abortSignal?.addEventListener('abort', abortFromGateway, { once: true });

  try {
    // No user CLI and no bundled binary → download the platform package on
    // first use (the DMG no longer ships the ~300MB fallback).
    const fallbackCodexPath = process.env.CODEX_CLI_PATH
      ? null
      : await ensureFallbackCodexBinary((progressMessage) => {
        sendMessage(ws, createNormalizedMessage({
          kind: 'status',
          content: progressMessage,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'codex',
        }));
      });

    const baseCodexEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    codex = new Codex({
      codexPathOverride: process.env.CODEX_CLI_PATH || fallbackCodexPath || undefined,
      // Active Leoapi provider is authoritative — clears any inherited shell
      // OPENAI_API_KEY (e.g. left by cc-switch) then applies the provider's,
      // so switching in Leoapi actually takes effect. See
      // provider-session-env.service.ts.
      env: await applyActiveSwitchEnv(baseCodexEnv, 'codex',
        typeof (options as { routingSlot?: unknown }).routingSlot === 'string'
          ? (options as { routingSlot: string }).routingSlot : undefined),
    });

    const threadOptions: ThreadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model: resolvedModel,
      modelReasoningEffort: resolvedEffort as ModelReasoningEffort | undefined,
    };

    if (sessionId) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    const registerSession = (id: string | null | undefined): void => {
      if (!id) {
        return;
      }
      runState.thread = thread;
      runState.codex = codex;
      activeCodexSessions.set(id, runState);
    };

    registerSession(appSessionId);
    if (capturedSessionId) {
      registerSession(capturedSessionId);
    }

    // Execute with streaming. Turns with image attachments send structured
    // input items so Codex reads the images from their local asset paths.
    const turnInput = normalizeImageDescriptors(images).length > 0
      ? buildCodexInputItems(command, images, workingDirectory)
      : command;
    const streamedTurn = await thread.runStreamed(turnInput, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      // Capture thread/session id lazily from the stream (Codex emits this asynchronously).
      if (event.type === 'thread.started') {
        const discoveredSessionId = event.thread_id || null;
        if (discoveredSessionId && !capturedSessionId) {
          capturedSessionId = discoveredSessionId;
          registerSession(capturedSessionId);

          if (ws.setSessionId && typeof ws.setSessionId === 'function') {
            ws.setSessionId(capturedSessionId);
          }

          if (!sessionId && !sessionCreatedSent) {
            sessionCreatedSent = true;
            sendMessage(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'codex' }));
          }
        }
      }

      // Check if session was aborted
      if (abortController.signal.aborted) {
        break;
      }
      if (capturedSessionId) {
        const session = activeCodexSessions.get(capturedSessionId);
        if (session?.status === 'aborted') {
          break;
        }
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      const transformed = transformCodexEvent(event);

      // Normalize the transformed event into NormalizedMessage(s) via adapter
      const normalizedMsgs = sessionsService.normalizeMessage('codex', transformed, capturedSessionId || sessionId || null);
      for (const msg of normalizedMsgs) {
        sendMessage(ws, msg);
      }

      if (event.type === 'turn.failed' && !terminalFailure) {
        terminalFailure = event.error || new Error('Turn failed');
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error: terminalFailure
        });
      }

      // Extract and send token usage if available (normalized to match Claude format)
      if (event.type === 'turn.completed') {
        const tokenBudget = extractCodexTokenBudget(event);
        if (tokenBudget) {
          sendMessage(ws, createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
        }
      }
    }

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const runSession = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const runAborted = runSession?.status === 'aborted' || abortController.signal.aborted;
    if (!runAborted) {
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        actualSessionId: capturedSessionId || thread.id || sessionId || null,
        exitCode: terminalFailure ? 1 : 0,
      }));
      if (!terminalFailure) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          stopReason: 'completed',
          durationMs: Date.now() - runStartedAtMs,
        });
      }
    }

  } catch (error) {
    const session = capturedSessionId ? activeCodexSessions.get(capturedSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      (error instanceof Error && error.name === 'AbortError') ||
      errorMessage(error).toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);

      // Check if Codex SDK is available for a clearer error message
      const installed = await providerAuthService.isProviderInstalled('codex');
      const errorContent = !installed
        ? 'Codex CLI is not configured. Please set up authentication first.'
        : errorMessage(error);

      sendMessage(ws, createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'codex' }));
      sendMessage(ws, createCompleteMessage({
        provider: 'codex',
        sessionId: capturedSessionId || sessionId || null,
        exitCode: 1,
      }));
      if (!terminalFailure) {
        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'codex',
          sessionId: capturedSessionId || sessionId || null,
          sessionName: sessionSummary,
          error
        });
      }
    }

  } finally {
    abortSignal?.removeEventListener('abort', abortFromGateway);
    // Update session status
    if (capturedSessionId) {
      const session = activeCodexSessions.get(capturedSessionId);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
    if (appSessionId && activeCodexSessions.get(appSessionId) === runState) {
      runState.status = runState.status === 'aborted' ? 'aborted' : 'completed';
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId: string): boolean {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws: RuntimeWriter, data: unknown): void {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically. The timer is maintenance-only
// and must not keep CLI commands or the Node test runner alive.
const completedSessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes
completedSessionCleanupTimer.unref?.();
