import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { appendImagesInputTag } from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/services/notification-orchestrator.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from '@/shared/utils.js';

// cross-spawn resolves the grok binary (native on macOS/Linux, .exe/.cmd on
// Windows) and delegates to child_process.spawn.
const spawnFunction = crossSpawn;

type GrokProcess = ChildProcess & { aborted?: boolean };
type RuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: number | null;
};
type GrokRuntimeOptions = {
  abortSignal?: AbortSignal;
  appSessionId?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
  cwd?: string | null;
  toolsSettings?: { skipPermissions?: boolean };
  skipPermissions?: boolean;
  permissionMode?: string;
  model?: string | null;
  effort?: string | null;
  sessionSummary?: string | null;
  images?: unknown[];
};

const activeGrokProcesses = new Map<string, GrokProcess>();

function terminateGrokProcess(childProcess: GrokProcess): boolean {
  try {
    if (process.platform !== 'win32' && childProcess.pid) process.kill(-childProcess.pid, 'SIGTERM');
    else childProcess.kill('SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * grok's `--permission-mode` values (default/acceptEdits/auto/dontAsk/
 * bypassPermissions/plan) line up almost 1:1 with the app's permission modes,
 * so the mapping is a passthrough with skipPermissions promoted to
 * bypassPermissions.
 */
export function resolveGrokPermissionMode(permissionMode: string | undefined, skipPermissions = false): string {
  if (skipPermissions) return 'bypassPermissions';
  switch (permissionMode) {
    case 'plan':
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'auto':
      return permissionMode;
    default:
      return 'default';
  }
}

async function spawnGrok(command: string, options: GrokRuntimeOptions = {}, writer: object): Promise<void> {
  const runStartedAtMs = Date.now();
  const ws = writer as RuntimeWriter;
  return new Promise<void>((resolve, reject) => {
    void (async () => {
      const { abortSignal, appSessionId, sessionId, projectPath, cwd, toolsSettings, skipPermissions, permissionMode, model, effort, sessionSummary, images } = options;
      const resolvedModel = await providerModelsService.resolveResumeModel('grok', appSessionId || sessionId || undefined, model || undefined);
      if (abortSignal?.aborted) {
        resolve();
        return;
      }

      // grok lets us DICTATE the session id up front via --session-id (verified:
      // the id we pass is exactly the one it reports in the `end` event). So for
      // a fresh chat we mint the native id ourselves and announce it before the
      // first byte of output — no need to fish it out of a start event.
      const isResume = Boolean(sessionId);
      let capturedSessionId = sessionId || crypto.randomUUID();
      let sessionCreatedSent = false;
      let settled = false;
      let completeSent = false;

      const args: string[] = [];
      if (isResume) {
        args.push('-r', capturedSessionId);
      } else {
        args.push('--session-id', capturedSessionId);
      }

      if (command && command.trim()) {
        // grok is a native binary on posix but may be a shim on Windows; keep
        // the prompt newline-free for the same reason cursor/opencode do.
        args.push('-p', flattenPromptForWindowsShell(appendImagesInputTag(command, images)));
      }
      if (resolvedModel) args.push('-m', resolvedModel);
      if (effort && effort !== 'default') args.push('--effort', effort);
      args.push('--permission-mode', resolveGrokPermissionMode(permissionMode, skipPermissions || toolsSettings?.skipPermissions));
      args.push('--output-format', 'streaming-json', '--no-alt-screen');

      const workingDir = cwd || projectPath || process.cwd();
      if (workingDir) args.push('--cwd', workingDir);

      const processKey = appSessionId || capturedSessionId;

      const settleOnce = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        callback();
      };

      // Announce the (self-assigned) native id immediately for new sessions so
      // the gateway can map it to the app session before any content streams.
      if (!isResume) {
        if (ws.setSessionId) ws.setSessionId(capturedSessionId);
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'grok', cwd: workingDir,
        }));
      }

      let stdoutLineBuffer = '';
      let stderrBuffer = '';
      let terminalNotificationSent = false;

      const notifyTerminalState = (code: number | null, error: unknown = null): void => {
        if (terminalNotificationSent) return;
        terminalNotificationSent = true;
        const finalSessionId = capturedSessionId || processKey;
        if (code === 0 && !error) {
          notifyRunStopped({ userId: ws?.userId || null, provider: 'grok', sessionId: finalSessionId, sessionName: sessionSummary, stopReason: 'completed', durationMs: Date.now() - runStartedAtMs });
        } else {
          notifyRunFailed({ userId: ws?.userId || null, provider: 'grok', sessionId: finalSessionId, sessionName: sessionSummary, error: error || `Grok CLI exited with code ${code}` });
        }
      };

      const grokProcess = spawnFunction('grok', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { ...process.env },
      }) as GrokProcess;

      activeGrokProcesses.set(processKey, grokProcess);
      if (processKey !== capturedSessionId) activeGrokProcesses.set(capturedSessionId, grokProcess);
      // capturedSessionId may later be reassigned on the defensive divergent-id
      // path; remember the key we actually registered so cleanup can't orphan it.
      const registeredSessionKey = capturedSessionId;

      const abortFromGateway = () => {
        grokProcess.aborted = true;
        terminateGrokProcess(grokProcess);
      };
      if (abortSignal?.aborted) abortFromGateway();
      else abortSignal?.addEventListener('abort', abortFromGateway, { once: true });

      const sendComplete = (exitCode: number | null): void => {
        if (completeSent || grokProcess.aborted) return;
        completeSent = true;
        ws.send(createCompleteMessage({ provider: 'grok', sessionId: capturedSessionId, exitCode }));
      };

      const processLine = (line: string): void => {
        if (!line || !line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Non-JSON stdout is a plain text delta.
          ws.send(createNormalizedMessage({ kind: 'stream_delta', content: line, sessionId: capturedSessionId, provider: 'grok' }));
          return;
        }

        if (event.type === 'end') {
          // Terminal event: carries the native session id + usage. `end` alone
          // never carries an error, so a clean end => exit 0.
          const endSessionId = typeof event.sessionId === 'string' ? event.sessionId : null;
          if (endSessionId && !isResume && endSessionId !== capturedSessionId) {
            // Defensive: honor grok's id if it ever diverges from ours.
            capturedSessionId = endSessionId;
            if (ws.setSessionId) ws.setSessionId(endSessionId);
          }
          if (event.usage && typeof event.usage === 'object') {
            ws.send(createNormalizedMessage({ kind: 'status', content: 'token_budget', sessionId: capturedSessionId, provider: 'grok', usage: event.usage }));
          }
          sendComplete(0);
          return;
        }

        // thought -> thinking, text -> stream_delta (handled in the adapter).
        const normalized = sessionsService.normalizeMessage('grok', event, capturedSessionId);
        for (const msg of normalized) ws.send(msg);
      };

      grokProcess.stdout?.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() || '';
        for (const line of lines) processLine(line.trim());
      });

      grokProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        stderrBuffer += text;
        if (text.trim()) console.error('Grok CLI stderr:', text);
      });

      grokProcess.on('close', (code) => {
        abortSignal?.removeEventListener('abort', abortFromGateway);
        activeGrokProcesses.delete(registeredSessionKey);
        activeGrokProcesses.delete(processKey);
        if (stdoutLineBuffer.trim()) {
          processLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }
        // grok also writes benign progress to stderr, so only surface it as an
        // error when the run actually failed and we haven't already completed —
        // otherwise a logged-out/bad-model run would end with no explanation.
        if (!grokProcess.aborted && code !== 0 && !completeSent && stderrBuffer.trim()) {
          ws.send(createNormalizedMessage({ kind: 'error', content: stderrBuffer.trim(), sessionId: capturedSessionId, provider: 'grok' }));
        }
        sendComplete(code);
        if (grokProcess.aborted) {
          settleOnce(() => resolve());
        } else if (code === 0) {
          // A null exit code here means an external signal killed grok (OOM,
          // manual kill) — our own abort is handled by the `aborted` branch
          // above, so treat null as a failure rather than a clean finish.
          notifyTerminalState(code);
          settleOnce(() => resolve());
        } else {
          notifyTerminalState(code);
          settleOnce(() => reject(new Error(`Grok CLI exited with code ${code}`)));
        }
      });

      grokProcess.on('error', async (error) => {
        abortSignal?.removeEventListener('abort', abortFromGateway);
        activeGrokProcesses.delete(registeredSessionKey);
        activeGrokProcesses.delete(processKey);
        const installed = await providerAuthService.isProviderInstalled('grok');
        const content = !installed
          ? 'Grok Build CLI is not installed. Install it from https://docs.x.ai/build.'
          : error.message;
        ws.send(createNormalizedMessage({ kind: 'error', content, sessionId: capturedSessionId, provider: 'grok' }));
        sendComplete(1);
        notifyTerminalState(1, error);
        settleOnce(() => reject(error));
      });

      // grok headless does not read interactive stdin; close it so the process
      // never blocks waiting for input.
      grokProcess.stdin?.end();
      void sessionCreatedSent;
    })();
  });
}

function abortGrokSession(sessionId: string): boolean {
  const childProcess = activeGrokProcesses.get(sessionId);
  if (childProcess) {
    childProcess.aborted = true;
    const terminated = terminateGrokProcess(childProcess);
    activeGrokProcesses.delete(sessionId);
    return terminated;
  }
  return false;
}

function isGrokSessionActive(sessionId: string): boolean {
  return activeGrokProcesses.has(sessionId);
}

export { spawnGrok, abortGrokSession, isGrokSessionActive };
