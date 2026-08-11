/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, Options, PermissionMode, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '@/modules/logging/index.js';
import { buildClaudeUserContent, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import { isMissingCliExecutableError } from '@/shared/provider-errors.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { applyActiveSwitchEnv } from '@/modules/leocodebox/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/services/notification-orchestrator.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

import { getModelContextWindow } from '../../model-metadata.js';

import { CLAUDE_FALLBACK_MODELS } from './claude-models.provider.js';


type RuntimeWriter = { send(data: unknown): void; setSessionId?(sessionId: string): void; updateWebSocket?(ws: unknown): void; userId?: number | null };
type ModelsDefinition = { OPTIONS?: Array<{ value?: string; effort?: { values?: Array<{ value?: string }> } }> };
type ToolSettings = { allowedTools?: string[]; disallowedTools?: string[]; skipPermissions?: boolean };
type ClaudeRuntimeOptions = {
  abortSignal?: AbortSignal;
  appSessionId?: string | null;
  sessionId?: string | null;
  sessionSummary?: string | null;
  cwd?: string;
  projectPath?: string | null;
  toolsSettings?: ToolSettings;
  permissionMode?: PermissionMode | 'default';
  effort?: string | null;
  model?: string | null;
  images?: unknown[];
  effortModels?: ModelsDefinition;
};
type MutableClaudeOptions = Options & { allowedTools: string[]; disallowedTools: string[] };
type ApprovalDecision = { cancelled?: boolean; allow?: boolean; rememberEntry?: unknown; updatedInput?: unknown; message?: string };
type ApprovalMetadata = { _sessionId?: string | null; _toolName?: string; _input?: unknown; _context?: unknown; _receivedAt?: Date };
type ApprovalResolver = ((decision: ApprovalDecision | null) => void) & ApprovalMetadata;
type WaitApprovalOptions = { timeoutMs?: number; signal?: AbortSignal; onCancel?: (reason: string) => void; metadata?: ApprovalMetadata };
type ActiveClaudeSession = { instance: Query; startTime: number; status: 'active' | 'aborted'; writer: RuntimeWriter | null };
type PendingApproval = { requestId: string; toolName: string; input: unknown; context: unknown; sessionId: string; receivedAt: Date };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

const activeSessions = new Map<string, ActiveClaudeSession>();
const pendingToolApprovals = new Map<string, ApprovalResolver>();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set<string>();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set<string>(['AskUserQuestion', 'ExitPlanMode']);

function resolveClaudeEffort(model: string | undefined, effort: string | null | undefined, modelsDefinition: ModelsDefinition = CLAUDE_FALLBACK_MODELS): EffortLevel | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort as EffortLevel
    : undefined;
}

function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId: string, options: WaitApprovalOptions = {}): Promise<ApprovalDecision | null> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise<ApprovalDecision | null>(resolve => {
    let settled = false;

    const finalize = (decision: ApprovalDecision | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver: ApprovalResolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId: string, decision: ApprovalDecision): void {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry: string, toolName: string, input: unknown): boolean {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof asRecord(input).command === 'string') {
      command = String(asRecord(input).command).trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options: ClaudeRuntimeOptions = {}): MutableClaudeOptions {
  const { sessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {} as MutableClaudeOptions;

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Desktop startup resolves the actual device-local CLI into CLAUDE_CLI_PATH,
  // keeping the status probe and the session runtime on the same executable.
  if (process.env.CLAUDE_CLI_PATH || process.platform === 'win32') {
    sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId: string, queryInstance: Query, writer: RuntimeWriter | null = null): ActiveClaudeSession {
  const session: ActiveClaudeSession = {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  };
  activeSessions.set(sessionId, session);
  return session;
}

function addSessionAlias(sessionId: string, session: ActiveClaudeSession): void {
  if (sessionId && session) activeSessions.set(sessionId, session);
}

function removeSessionAliases(session: ActiveClaudeSession): void {
  for (const [id, candidate] of activeSessions.entries()) {
    if (candidate === session) activeSessions.delete(id);
  }
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId: string): ActiveClaudeSession | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions(): string[] {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage: SDKMessage): Record<string, unknown> {
  const message = asRecord(sdkMessage);
  const parentToolUseId = message.parent_tool_use_id;
  return typeof parentToolUseId === 'string'
    ? { ...message, parentToolUseId }
    : message;
}

function readNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage: SDKMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const sdkRecord = asRecord(sdkMessage);
  const messageUsage = asRecord(asRecord(sdkRecord.message).usage || sdkRecord.usage);
  if (Object.keys(messageUsage).length > 0) {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const model = typeof asRecord(sdkRecord.message).model === 'string' ? asRecord(sdkRecord.message).model as string : undefined;
    const contextWindow = getModelContextWindow('claude', model);

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  const modelUsage = asRecord(sdkRecord.modelUsage);
  if (Object.keys(modelUsage).length === 0) {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(modelUsage)[0];
  const modelData = asRecord(modelUsage[modelKey]);

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = getModelContextWindow('claude', modelKey);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.leocodebox/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {string} cwd - Project working directory image paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command: string, images: unknown[] | undefined, cwd: string | undefined): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (normalizeImageDescriptors(images).length === 0) {
    return command;
  }

  const content = await buildClaudeUserContent(command, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    } as SDKUserMessage;
  })();
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd: string | undefined): Promise<Options['mcpServers'] | null> {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', errorMessage(error));
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    const projectConfigs = claudeConfig.projects || claudeConfig.claudeProjects;
    if (projectConfigs && cwd) {
      const projectConfig = projectConfigs[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', errorMessage(error));
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command: string, options: ClaudeRuntimeOptions = {}, writer: object): Promise<void> {
  const runStartedAtMs = Date.now();
  const ws = writer as RuntimeWriter;
  const { abortSignal, appSessionId, sessionId, sessionSummary } = options;
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;

  const emitNotification = (event: ReturnType<typeof createNotificationEvent>): void => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      event
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      appSessionId || sessionId || undefined,
      options.model || undefined,
    );
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = (await providerModelsService.getProviderModels('claude')).models;
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
      effortModels,
    });
    // The active Leoapi provider must beat any ANTHROPIC_* vars inherited
    // from the login shell (e.g. exports left behind by another switcher like
    // cc-switch) — otherwise switching endpoints in Leoapi silently does
    // nothing here. applyActiveSwitchEnv clears the stale inherited keys first,
    // so the active provider fully replaces them (not just the ones it sets).
    // A routing slot (set by an agent profile / mission card) picks a specific
    // Leoapi provider for this session; an unbound slot falls back to the active
    // provider, so plain sessions are unaffected.
    const routingSlot = typeof (options as { routingSlot?: unknown }).routingSlot === 'string'
      ? (options as { routingSlot: string }).routingSlot
      : undefined;
    sdkOptions.env = await applyActiveSwitchEnv(sdkOptions.env ?? {}, 'claude', routingSlot);

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    if (abortSignal?.aborted) return;

    // Turns with image attachments switch to streaming input so the images
    // ride along as real content blocks. Built per query attempt because an
    // async generator cannot be replayed once consumed.
    const createPrompt = (): Promise<string | AsyncIterable<SDKUserMessage>> => buildPromptPayload(command, options.images, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const hookInput = asRecord(input);
          const message = typeof hookInput.message === 'string' ? hookInput.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          if (reason === 'timeout') {
            emitNotification(createNotificationEvent({
              provider: 'claude',
              sessionId: capturedSessionId || sessionId || null,
              kind: 'action_required',
              code: 'permission.timed_out',
              meta: { toolName, sessionName: sessionSummary, requestId },
              severity: 'warning',
              requiresUserAction: true,
              dedupeKey: `claude:permission-timeout:${capturedSessionId || sessionId || 'none'}:${requestId}`,
            }));
          }
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: Object.keys(asRecord(decision.updatedInput)).length ? asRecord(decision.updatedInput) : input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // Query constructor reads this synchronously.
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    let queryInstance: Query;
    try {
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', errorMessage(hookError));
      delete sdkOptions.hooks;
      queryInstance = query({
        prompt: await createPrompt(),
        options: sdkOptions
      });
    }

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    const trackedSession = appSessionId
      ? addSession(appSessionId, queryInstance, ws)
      : capturedSessionId
        ? addSession(capturedSessionId, queryInstance, ws)
        : null;
    if (capturedSessionId && trackedSession) addSessionAlias(capturedSessionId, trackedSession);

    const abortFromGateway = () => {
      void queryInstance.interrupt().catch((error) => {
        console.warn('[Claude SDK] Failed to interrupt an aborted startup:', errorMessage(error));
      });
    };
    if (abortSignal?.aborted) {
      abortFromGateway();
      if (trackedSession) removeSessionAliases(trackedSession);
      return;
    }
    abortSignal?.addEventListener('abort', abortFromGateway, { once: true });

    // Process streaming messages
    logger.info('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        if (trackedSession) addSessionAlias(capturedSessionId, trackedSession);
        else addSession(capturedSessionId, queryInstance, ws);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Extract and send token budget updates from assistant/result usage payloads
      const tokenBudgetData = extractTokenBudget(message);
      if (tokenBudgetData) {
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }
    }

    // Clean up session on completion
    if (trackedSession) removeSessionAliases(trackedSession);
    else if (capturedSessionId) removeSession(capturedSessionId);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    abortSignal?.removeEventListener('abort', abortFromGateway);
    const providerIdAborted = Boolean(capturedSessionId && abortedSessionIds.delete(capturedSessionId));
    const appIdAborted = Boolean(appSessionId && abortedSessionIds.delete(appSessionId));
    const wasAborted = providerIdAborted || appIdAborted || Boolean(abortSignal?.aborted);
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed',
      durationMs: Date.now() - runStartedAtMs,
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    const trackedSession = (appSessionId ? getSession(appSessionId) : undefined) || (capturedSessionId ? getSession(capturedSessionId) : undefined);
    if (trackedSession) removeSessionAliases(trackedSession);
    else if (capturedSessionId) removeSession(capturedSessionId);

    const providerIdAborted = Boolean(capturedSessionId && abortedSessionIds.delete(capturedSessionId));
    const appIdAborted = Boolean(appSessionId && abortedSessionIds.delete(appSessionId));
    const wasAborted = providerIdAborted || appIdAborted || Boolean(abortSignal?.aborted);
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    const missingExecutable = isMissingCliExecutableError(error, 'claude');
    const errorContent = missingExecutable
      ? '未检测到可运行的 Claude Code。请在终端执行 claude --version，并在设置中检查 Agent CLI 路径。'
      : errorMessage(error);

    // Send error to WebSocket, then the terminal complete
    ws.send(createNormalizedMessage({
      kind: 'error',
      content: errorContent,
      errorCode: missingExecutable ? 'PROVIDER_CLI_NOT_FOUND' : 'PROVIDER_RUN_FAILED',
      sessionId: capturedSessionId || sessionId || null,
      provider: 'claude',
    }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId: string): Promise<boolean> {
  const session = getSession(sessionId);

  if (!session) {
    logger.info(`Session ${sessionId} not found`);
    return false;
  }

  try {
    logger.info(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    for (const [id, candidate] of activeSessions.entries()) {
      if (candidate === session) abortedSessionIds.add(id);
    }

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSessionAliases(session);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    for (const [id, candidate] of activeSessions.entries()) {
      if (candidate === session) abortedSessionIds.delete(id);
    }
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId: string): boolean {
  const session = getSession(sessionId);
  return session?.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions(): string[] {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId: string): PendingApproval[] {
  const pending: PendingApproval[] = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId: string, newRawWs: unknown): boolean {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  logger.info(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
