/**
 * pathDerivations — renderer-side pure functions mirroring
 * `apps/desktop/src/main/skillhub/registry/derivations.ts`.
 *
 * Main process uses `node:path` / `node:os`; renderer cannot import those.
 * This file reimplements the same logic using only string operations so that
 * results are byte-equal to the main-process equivalents on both POSIX and
 * Windows.
 *
 * Invariant (verified by shared unit-test fixture in pathDerivations.test.ts):
 *   deriveScope(p)                === main.deriveScope(p)
 *   deriveProjectWorkingDir(p)    === main.deriveProjectWorkingDir(p)
 * for every absolute path in the fixture set.
 */

export type SkillScope = 'global' | 'project';

// ── Platform helpers ──────────────────────────────────────────────────────────

/**
 * Normalise a path the same way `path.normalize` does:
 *   - Replace all backslashes with the platform separator (forward slash on POSIX,
 *     backslash on Windows). We detect Windows by checking if absolutePath[1] === ':'.
 *   - Collapse consecutive separators.
 *   - Remove trailing separator (except root).
 *
 * We unify to the separator already present in the path rather than
 * hard-coding one, so POSIX paths work on Windows and vice versa.
 */
function normalize(p: string): string {
  // Detect separator from the path (Windows absolute = starts with drive letter + colon)
  const isWindows = p.length >= 2 && p[1] === ':';
  const sep = isWindows ? '\\' : '/';
  const otherSep = isWindows ? '/' : '\\';

  // Replace all occurrences of the other separator with our sep.
  let normalised = p.split(otherSep).join(sep);

  // Collapse consecutive separators (but keep leading double-sep for UNC paths on Windows).
  const leadingUNC = isWindows && normalised.startsWith('\\\\');
  if (leadingUNC) {
    normalised = '\\\\' + normalised.slice(2).replace(/\\{2,}/g, sep);
  } else {
    normalised = normalised.replace(new RegExp(`${sep === '\\' ? '\\\\' : '/'}+`, 'g'), sep);
  }

  // Remove trailing separator unless it's the root ('/') or drive root ('C:\').
  const isRoot = normalised === sep || (isWindows && normalised.match(/^[A-Za-z]:\\?$/));
  if (!isRoot && normalised.endsWith(sep)) {
    normalised = normalised.slice(0, -1);
  }

  return normalised;
}

function dirname(p: string): string {
  const isWindows = p.length >= 2 && p[1] === ':';
  const sep = isWindows ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  if (idx === -1) return '.';
  if (idx === 0) return sep; // POSIX root
  if (isWindows && idx === 2) return p.slice(0, 3); // 'C:\'
  return p.slice(0, idx);
}

function basename(p: string): string {
  const isWindows = p.length >= 2 && p[1] === ':';
  const sep = isWindows ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx === -1 ? p : p.slice(idx + 1);
}

// ── Global skills base path ───────────────────────────────────────────────────

/**
 * globalSkillsBase: the prefix that global-scope skills live under.
 * We cannot call os.homedir() in renderer, so we derive it from the skill's
 * absolutePath by checking whether the second-from-last dirname segment is
 * 'skills' and the one above is '.claude'.
 *
 * Instead, deriveScope detects global scope structurally:
 * a path is global iff its three ancestor segments (from the leaf) are:
 *   <anything>/.claude/skills/<skillName>
 */

/**
 * Return 'global' if the install path lives under ~/.claude/skills/,
 * 'project' otherwise.
 *
 * Global home directories on both POSIX and macOS are always exactly
 * 2 path segments deep from the filesystem root (e.g. /home/user or
 * /Users/user). On Windows the drive root counts as depth 0, so
 * C:\Users\user is also depth 2.
 *
 * Strategy: find the '.claude/skills' pair anywhere in the path, then
 * count how many non-empty segments precede the '.claude' segment.
 * If exactly 2, it's a global install; otherwise it's a project install.
 *
 * **Known edge case — non-standard home directories**: on systems where
 * the home directory is not at depth 2 (e.g. `/opt/users/sam`,
 * `/data/home/sam/`, corporate or container environments with deep
 * home hierarchies), `deriveScope` will classify the path as 'project'
 * even though it is actually a global install. This renderer
 * implementation cannot call `os.homedir()`, so it relies on structural
 * depth rather than exact comparison; the main-process `derivations.ts`
 * (which uses `os.homedir()`) may therefore return a different result for
 * those paths. This divergence is an accepted known limitation.
 */
export function deriveScope(installPath: string): SkillScope {
  const norm = normalize(installPath);
  const isWindows = norm.length >= 2 && norm[1] === ':';
  const sep = isWindows ? '\\' : '/';

  const parts = norm.split(sep).filter(Boolean);

  const globalParents = ['.claude', '.agents', '.codex'];

  for (let i = 0; i < parts.length - 1; i++) {
    if (globalParents.includes(parts[i]) && parts[i + 1] === 'skills') {
      if (isWindows) {
        const isHomeDir = i === 3 && parts[1] !== undefined &&
          parts[1].toLowerCase() === 'users';
        return isHomeDir ? 'global' : 'project';
      } else {
        return i === 2 ? 'global' : 'project';
      }
    }
  }
  return 'project';
}

/**
 * From a project-scope installPath, derive the project working directory.
 * Returns null for global scope.
 *
 * installPath = <projectRoot>/.claude/skills/<skillName>
 * → dirname 3 times → <projectRoot>
 */
export function deriveProjectWorkingDir(installPath: string): string | null {
  if (deriveScope(installPath) === 'global') return null;
  const norm = normalize(installPath);
  return dirname(dirname(dirname(norm)));
}

// ── Re-export basename for convenience (MarketSelectionPanel uses it) ─────────
export { basename };
