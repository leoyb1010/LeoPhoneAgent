/**
 * useSessionDiffs
 * ---------------------------------------------------------------------------
 * F-DIFF-1 — aggregate every Edit / Write / MultiEdit tool_use in the current
 * session into a per-file change list, sorted by file path with the operations
 * inside each file kept in chronological order.
 *
 * Read intentionally not included — "改动" means actually-written, so reads
 * (which never modify the file) would dilute the panel. If we ever want a
 * "files touched" view we'd build it as a separate hook.
 *
 * Multi-edit policy: each Edit on the same file stacks as its own hunk. We do
 * NOT merge into a final-state diff — preserving the agent's step sequence is
 * the more useful read of "what happened".
 */
import { useMemo } from 'react';
import { computeDiffStats } from '@/lib/agent-actions/diffStats';
import type { ChatMessage } from '@/lib/makerChatStore';

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export interface DiffOp {
  /** clientId of the source tool_use message (stable key for React) */
  messageId: string;
  /** Edit | Write | MultiEdit — tells the renderer how to label the hunk */
  toolName: string;
  oldString: string;
  newString: string;
  add: number;
  del: number;
}

export interface FileDiff {
  filePath: string;
  ops: DiffOp[];
  totalAdd: number;
  totalDel: number;
  /**
   * Number of tool_use *messages* that touched this file.
   * (A single MultiEdit counts as 1 even if it bundled many hunks — matches
   * how a user would describe "how many times the agent edited this file".)
   */
  touchCount: number;
}

export interface SessionDiffs {
  files: FileDiff[];
  totalFiles: number;
  totalAdd: number;
  totalDel: number;
  totalOps: number;
}

/**
 * Pull the file path out of a tool input. Handles the three diff tools —
 * which all happen to use `file_path` — but kept centralized so a future
 * tool with a different key can be slotted in without scattering the check.
 */
function extractFilePath(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const fp = input.file_path;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

/**
 * Expand a single tool_use message into one or more DiffOp entries.
 * Edit / Write each yield 1 op; MultiEdit yields one op per element of `edits`.
 */
function opsForMessage(msg: ChatMessage): DiffOp[] {
  const inp = (msg.toolInput as Record<string, unknown> | null) ?? null;
  if (!inp) return [];
  const toolName = msg.toolName ?? '';

  if (toolName === 'Edit') {
    const o = typeof inp.old_string === 'string' ? inp.old_string : '';
    const n = typeof inp.new_string === 'string' ? inp.new_string : '';
    const stats = computeDiffStats(o, n);
    return [{ messageId: msg.clientId, toolName, oldString: o, newString: n, ...stats }];
  }

  if (toolName === 'Write') {
    const c = typeof inp.content === 'string' ? inp.content : '';
    const stats = computeDiffStats('', c);
    return [{ messageId: msg.clientId, toolName, oldString: '', newString: c, ...stats }];
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    return edits.map((e, i) => {
      const er = e as Record<string, unknown> | null;
      const o = er && typeof er.old_string === 'string' ? (er.old_string as string) : '';
      const n = er && typeof er.new_string === 'string' ? (er.new_string as string) : '';
      const stats = computeDiffStats(o, n);
      // Suffix with #i so React keys stay unique within one MultiEdit message.
      return { messageId: `${msg.clientId}#${i}`, toolName, oldString: o, newString: n, ...stats };
    });
  }

  return [];
}

export function useSessionDiffs(messages: ChatMessage[]): SessionDiffs {
  return useMemo(() => {
    const byFile = new Map<string, FileDiff>();
    let totalOps = 0;

    for (const msg of messages) {
      if (msg.role !== 'tool_use') continue;
      const toolName = msg.toolName ?? '';
      if (!DIFF_TOOLS.has(toolName)) continue;

      const inp = (msg.toolInput as Record<string, unknown> | null) ?? null;
      const filePath = extractFilePath(inp);
      if (!filePath) continue;

      const ops = opsForMessage(msg);
      if (ops.length === 0) continue;

      let bucket = byFile.get(filePath);
      if (!bucket) {
        bucket = { filePath, ops: [], totalAdd: 0, totalDel: 0, touchCount: 0 };
        byFile.set(filePath, bucket);
      }
      bucket.ops.push(...ops);
      for (const op of ops) {
        bucket.totalAdd += op.add;
        bucket.totalDel += op.del;
      }
      bucket.touchCount += 1;
      totalOps += 1;
    }

    // Stable order: by file path, ascending. Insertion order would surface
    // recently-touched first — useful, but unstable across re-renders if the
    // same file re-appears later. Alphabetic is more predictable.
    const files = [...byFile.values()].sort((a, b) =>
      a.filePath.localeCompare(b.filePath),
    );

    let totalAdd = 0;
    let totalDel = 0;
    for (const f of files) {
      totalAdd += f.totalAdd;
      totalDel += f.totalDel;
    }

    return {
      files,
      totalFiles: files.length,
      totalAdd,
      totalDel,
      totalOps,
    };
  }, [messages]);
}
