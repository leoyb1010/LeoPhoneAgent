/**
 * shared/assertInsidePath.ts
 * ---------------------------------------------------------------------------
 * Session-workingDir path boundary guard for MCP tools.
 *
 * Several MCP tools take a filesystem path straight from LLM-supplied
 * arguments (out_file / savePath / screenshot_out_file / file_path …). Because
 * those arguments are attacker-controllable via prompt injection, an
 * unconstrained absolute path lets the model write to `~/.zshrc` /
 * `~/.ssh/authorized_keys` (RCE) or read `~/.ssh/id_rsa` / `.env` and exfil it
 * through an upload tool.
 *
 * Per docs/dev-rules/maker-core-and-agent-behavior.md (代码保证确定性, 不靠 prompt/审批兜底) the fix is a
 * deterministic, fail-closed boundary: every such path MUST resolve to a
 * location inside the current session `workingDir`. This module is the single
 * shared implementation wired into every offending tool.
 *
 * Threat model & defenses (mirrors file-browser-core/scanner.ts):
 *   - Relative inputs are resolved against `root`; absolute inputs must already
 *     fall inside `root`.
 *   - `..` traversal is normalized by path.resolve, then rejected by a lexical
 *     containment check.
 *   - Symlink escapes are rejected by realpath-ing the nearest EXISTING
 *     ancestor of the target (the target itself may not exist yet for writes)
 *     and re-checking containment — a symlinked prefix that points outside
 *     root can therefore not redirect a write/read out of the sandbox.
 *   - Windows case-insensitivity is handled via path.relative (win32 compares
 *     case-insensitively), so a legit in-root path is never falsely rejected.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Thrown when a caller-supplied path resolves outside the allowed root (or the
 * root itself is unusable). Callers translate this into a tool-level errorCode
 * so the LLM sees a clear, fail-closed rejection instead of a silent write.
 */
export class PathBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathBoundaryError';
  }
}

/**
 * True when `child` is `parent` itself or nested inside it. Uses path.relative
 * so the comparison is correct on both POSIX (case-sensitive) and Windows
 * (case-insensitive) without hand-rolling `startsWith(parent + sep)`.
 */
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Walk up from `p` until an existing path is found, then return its realpath.
 * Used to symlink-check the deepest existing ancestor of a write target that
 * may not exist yet. Throws only when even the filesystem root can't be
 * realpath'd (should never happen in practice).
 */
async function realpathNearestExisting(p: string): Promise<string> {
  let current = p;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root and still nothing resolvable.
        throw new PathBoundaryError(`无法解析路径的任何父目录: ${p}`);
      }
      current = parent;
    }
  }
}

/**
 * Resolve `inputPath` against `root` and assert the result stays inside
 * `root`, defending against `..` traversal and symlink escapes. Returns the
 * absolute, boundary-checked path (safe to mkdir -p + write, or read).
 *
 * @param root      Absolute session working directory. Must be non-empty and
 *                  exist — an empty/unusable root throws (callers decide
 *                  whether to fall back to a managed default or fail-closed
 *                  BEFORE calling this).
 * @param inputPath LLM-supplied path (absolute or relative to `root`).
 * @throws PathBoundaryError on empty root, empty input, `..`/absolute escape,
 *         or symlink escape.
 */
export async function resolvePathInsideRoot(
  root: string,
  inputPath: string,
): Promise<string> {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new PathBoundaryError('当前会话无 workingDir,拒绝文件路径操作');
  }
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new PathBoundaryError('文件路径为空');
  }

  const rootAbs = path.resolve(root);
  const targetAbs = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(rootAbs, inputPath);

  // Fast lexical reject for `..` traversal and absolute paths outside root.
  if (!isInside(rootAbs, targetAbs)) {
    throw new PathBoundaryError(
      `路径越界: "${inputPath}" 解析后不在 workingDir (${rootAbs}) 内`,
    );
  }

  // Symlink-safe check: the root and the deepest existing ancestor of the
  // target must both be inside the real root. This catches a symlinked prefix
  // pointing outside the sandbox even when the final file does not exist yet.
  let rootReal: string;
  try {
    rootReal = await fs.realpath(rootAbs);
  } catch {
    throw new PathBoundaryError(`workingDir 不存在或不可访问: ${rootAbs}`);
  }
  const ancestorReal = await realpathNearestExisting(targetAbs);
  if (!isInside(rootReal, ancestorReal)) {
    throw new PathBoundaryError(
      `路径经 symlink 越界: "${inputPath}" 指向 workingDir 之外`,
    );
  }

  return targetAbs;
}

/**
 * Standard fail-closed tool result for a path that exceeds the session
 * boundary. Shared by github / gitlab / jira server.ts to avoid duplication.
 */
export function pathNotAllowedResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, errorCode: 'PATH_NOT_ALLOWED', data: { message } }),
      },
    ],
    isError: true,
  };
}
