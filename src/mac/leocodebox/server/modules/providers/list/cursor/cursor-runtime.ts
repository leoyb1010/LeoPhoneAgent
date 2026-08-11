import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { logger } from '@/modules/logging/index.js';
import { appendImagesInputTag } from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/services/notification-orchestrator.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { createCompleteMessage, createNormalizedMessage, flattenPromptForWindowsShell } from '@/shared/utils.js';

// cross-spawn resolves .cmd shims/PATHEXT on Windows and delegates to
// child_process.spawn everywhere else.
const spawnFunction = crossSpawn;

type CursorProcess = ChildProcess & { aborted?: boolean };
type RuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: number | null;
};
type CursorRuntimeOptions = {
  abortSignal?: AbortSignal;
  appSessionId?: string | null;
  sessionId?: string | null;
  projectPath?: string | null;
  cwd?: string | null;
  toolsSettings?: { allowedShellCommands?: string[]; skipPermissions?: boolean };
  skipPermissions?: boolean;
  permissionMode?: string;
  model?: string | null;
  sessionSummary?: string | null;
  images?: unknown[];
};
type TerminalState = { code?: number | null; error?: unknown };


const activeCursorProcesses = new Map<string, CursorProcess>(); // Track active processes by session ID

function terminateCursorProcess(childProcess: CursorProcess): boolean {
  try {
    if (process.platform !== 'win32' && childProcess.pid) process.kill(-childProcess.pid, 'SIGTERM');
    else childProcess.kill('SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export function resolveCursorPermissionArgs(permissionMode: string | undefined, skipPermissions = false): string[] {
  if (permissionMode === 'plan') return ['--plan'];
  if (permissionMode === 'bypassPermissions' || skipPermissions) return ['-f'];
  if (permissionMode === 'acceptEdits') return ['--auto-review'];
  return [];
}

async function spawnCursor(command: string, options: CursorRuntimeOptions = {}, writer: object): Promise<void> {
  const runStartedAtMs = Date.now();
  const ws = writer as RuntimeWriter;
  return new Promise<void>(async (resolve, reject) => {
    const { abortSignal, appSessionId, sessionId, projectPath, cwd, toolsSettings, skipPermissions, permissionMode, model, sessionSummary, images } = options;
    const resolvedModel = await providerModelsService.resolveResumeModel('cursor', appSessionId || sessionId || undefined, model || undefined);
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    let settled = false;
    // The unified lifecycle contract requires exactly one terminal `complete`
    // per run. Cursor surfaces completion twice (the `result` JSON line and
    // the process close), so the first emission wins.
    let completeSent = false;

    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedShellCommands: [],
      skipPermissions: false
    };

    // Build Cursor CLI command
    const baseArgs: string[] = [];

    // Build flags allowing both resume and prompt together (reply in existing session)
    // Treat presence of sessionId as intention to resume, regardless of resume flag
    if (sessionId) {
      baseArgs.push('--resume=' + sessionId);
    }

    if (command && command.trim()) {
      // Provide a prompt (works for both new and resumed sessions). Image
      // attachments ride along as an <images_input> path list appended to the
      // prompt; the session history reader strips the tag back out for display.
      // cursor-agent is a .cmd shim on Windows, so the whole argument must be
      // newline-free or cmd.exe silently truncates it at the first newline.
      baseArgs.push('-p', flattenPromptForWindowsShell(appendImagesInputTag(command, images)));

      // Model overrides are applied to both new and resumed sessions so a
      // session-scoped change request can take effect on the next turn.
      if (resolvedModel) {
        baseArgs.push('--model', resolvedModel);
      }

      // Request streaming JSON when we are providing a prompt
      baseArgs.push('--output-format', 'stream-json');
    }

    baseArgs.push(...resolveCursorPermissionArgs(permissionMode, skipPermissions || settings.skipPermissions));

    // Use cwd (actual project directory) instead of projectPath
    const workingDir = cwd || projectPath || process.cwd();

    // Store process reference for potential abort
    const processKey = appSessionId || capturedSessionId || Date.now().toString();

    const settleOnce = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const runCursorProcess = (args: string[]): void => {
      let stdoutLineBuffer = '';
      let terminalNotificationSent = false;

      const notifyTerminalState = ({ code = null, error = null }: TerminalState = {}): void => {
        if (terminalNotificationSent) {
          return;
        }

        terminalNotificationSent = true;

        const finalSessionId = capturedSessionId || sessionId || processKey;
        if (code === 0 && !error) {
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'cursor',
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            stopReason: 'completed',
            durationMs: Date.now() - runStartedAtMs,
          });
          return;
        }

        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'cursor',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          error: error || `Cursor CLI exited with code ${code}`
        });
      };

      const cursorProcess = spawnFunction('cursor-agent', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { ...process.env } // Inherit all environment variables
      }) as CursorProcess;

      activeCursorProcesses.set(processKey, cursorProcess);
      const abortFromGateway = () => {
        cursorProcess.aborted = true;
        terminateCursorProcess(cursorProcess);
      };
      if (abortSignal?.aborted) abortFromGateway();
      else abortSignal?.addEventListener('abort', abortFromGateway, { once: true });

      const processCursorOutputLine = (line: string): void => {
        if (!line || !line.trim()) {
          return;
        }

        try {
          const response = JSON.parse(line);

          // Handle different message types
          switch (response.type) {
            case 'system':
              if (response.subtype === 'init') {
                // Capture session ID
                if (response.session_id && !capturedSessionId) {
                  const newSessionId = String(response.session_id);
                  capturedSessionId = newSessionId;

                  // Update process key with captured session ID
                  if (processKey !== capturedSessionId) {
                    activeCursorProcesses.set(newSessionId, cursorProcess);
                  }

                  // Set session ID on writer (for API endpoint compatibility)
                  if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                    ws.setSessionId(newSessionId);
                  }

                  // Send session-created event only once for new sessions
                  if (!sessionId && !sessionCreatedSent) {
                    sessionCreatedSent = true;
                    ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, model: response.model, cwd: response.cwd, sessionId: capturedSessionId, provider: 'cursor' }));
                  }
                }

                // System info — no longer needed by the frontend (session-lifecycle 'created' handles nav).
              }
              break;

            case 'user':
              // User messages are not displayed in the UI — skip.
              break;

            case 'assistant':
              // Accumulate assistant message chunks
              if (response.message && response.message.content && response.message.content.length > 0) {
                const normalized = sessionsService.normalizeMessage('cursor', response, capturedSessionId || sessionId || null);
                for (const msg of normalized) ws.send(msg);
              }
              break;

            case 'result': {
              // Session complete — terminal lifecycle event for this run
              if (!completeSent) {
                completeSent = true;
                ws.send(createCompleteMessage({
                  provider: 'cursor',
                  sessionId: capturedSessionId || sessionId || null,
                  exitCode: response.subtype === 'success' ? 0 : 1,
                }));
              }
              break;
            }

            default:
              // Unknown message types — ignore.
          }
        } catch (parseError) {
          // If not JSON, send as stream delta via adapter
          const normalized = sessionsService.normalizeMessage('cursor', line, capturedSessionId || sessionId || null);
          for (const msg of normalized) ws.send(msg);
        }
      };

      // Handle stdout (streaming JSON responses)
      cursorProcess.stdout?.on('data', (data) => {
        const rawOutput = data.toString();

        // Stream chunks can split JSON objects across packets; keep trailing partial line.
        stdoutLineBuffer += rawOutput;
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processCursorOutputLine(line.trim());
        });
      });

      // Handle stderr
      cursorProcess.stderr?.on('data', (data) => {
        const stderrText = data.toString();
        console.error('Cursor CLI stderr:', stderrText);

        ws.send(createNormalizedMessage({ kind: 'error', content: stderrText, sessionId: capturedSessionId || sessionId || null, provider: 'cursor' }));
      });

      // Handle process completion
      cursorProcess.on('close', async (code) => {
        abortSignal?.removeEventListener('abort', abortFromGateway);
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeCursorProcesses.delete(finalSessionId);
        activeCursorProcesses.delete(processKey);

        // Flush any final unterminated stdout line before completion handling.
        if (stdoutLineBuffer.trim()) {
          processCursorOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        // Terminal complete — unless the `result` line already sent it, or the
        // run was aborted (abort-session sent the aborted complete).
        if (!completeSent && !cursorProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'cursor', sessionId: finalSessionId, exitCode: code }));
        }

        if (cursorProcess.aborted) {
          settleOnce(() => resolve());
        } else if (code === 0) {
          notifyTerminalState({ code });
          settleOnce(() => resolve());
        } else {
          notifyTerminalState({ code });
          settleOnce(() => reject(new Error(`Cursor CLI exited with code ${code}`)));
        }
      });

      // Handle process errors
      cursorProcess.on('error', async (error) => {
        abortSignal?.removeEventListener('abort', abortFromGateway);
        console.error('Cursor CLI process error:', error);

        // Clean up process reference on error
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeCursorProcesses.delete(finalSessionId);
        activeCursorProcesses.delete(processKey);

        // Check if Cursor CLI is installed for a clearer error message
        const installed = await providerAuthService.isProviderInstalled('cursor');
        const errorContent = !installed
          ? 'Cursor CLI is not installed. Please install it from https://cursor.com'
          : error.message;

        ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'cursor' }));
        if (!completeSent && !cursorProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'cursor', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
        }
        notifyTerminalState({ error });

        settleOnce(() => reject(error));
      });

      // Close stdin since Cursor doesn't need interactive input
      cursorProcess.stdin?.end();
    };

    runCursorProcess(baseArgs);
  });
}

function abortCursorSession(sessionId: string): boolean {
  const process = activeCursorProcesses.get(sessionId);
  if (process) {
    logger.info(`Aborting Cursor session: ${sessionId}`);
    // The abort handler sends the terminal complete (aborted: true); flag the
    // process so its close handler does not emit a second one.
    process.aborted = true;
    const terminated = terminateCursorProcess(process);
    activeCursorProcesses.delete(sessionId);
    return terminated;
  }
  return false;
}

function isCursorSessionActive(sessionId: string): boolean {
  return activeCursorProcesses.has(sessionId);
}

function getActiveCursorSessions(): string[] {
  return Array.from(activeCursorProcesses.keys());
}

export {
  spawnCursor,
  abortCursorSession,
  isCursorSessionActive,
  getActiveCursorSessions
};
