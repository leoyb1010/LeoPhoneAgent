import fs from 'node:fs';
import path from 'node:path';
import { ownerScopedUserDataPath } from '../appSessionState.js';

/**
 * Build the local date bucket used for XDT-created standalone dialogues.
 *
 * Use local calendar time instead of UTC so the folder layout matches what the
 * user sees in the desktop app on that machine.
 */
export function dialogueWorkspaceDayKey(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Root directory owned by xdt-maker for folderless dialogue workspaces. */
export function dialogueWorkspaceRootDir(): string {
  return ownerScopedUserDataPath('dialogues');
}

/**
 * App-managed cwd for an XDT-created dialogue that did not receive an explicit
 * folder. Imported Codex dialogues, or future explicitly-foldered dialogues,
 * keep their original workingDir and do not call this helper.
 */
export function buildDialogueWorkspaceDir(sessionId: string, nowMs: number): string {
  return path.join(
    dialogueWorkspaceRootDir(),
    dialogueWorkspaceDayKey(nowMs),
    sessionId,
  );
}

/** Create and return the app-managed dialogue cwd. */
export function ensureDialogueWorkspaceDir(sessionId: string, nowMs: number): string {
  const dir = buildDialogueWorkspaceDir(sessionId, nowMs);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
