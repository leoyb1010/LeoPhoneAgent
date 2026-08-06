/**
 * Git path and object id guards for git-review IPC trust boundaries.
 *
 * Renderer payloads are untrusted: paths must stay repo-relative git paths and
 * object ids must be raw hashes before they are passed to fs or git commands.
 */

export function isSafeGitPath(gitPath: string): boolean {
  if (!gitPath || gitPath.startsWith('/') || gitPath.includes('\\') || /^[a-zA-Z]:/.test(gitPath)) return false;
  return gitPath.split('/').every((segment) => {
    if (segment === '' || segment === '.' || segment === '..') return false;
    const windowsNormalizedSegment = segment.replace(/[. ]+$/g, '').toLowerCase();
    return windowsNormalizedSegment !== '.git' && !/^git~\d+$/i.test(segment);
  });
}

export function isSafeGitObjectOid(oid: unknown): oid is string {
  return typeof oid === 'string' && /^[0-9a-f]{40,64}$/i.test(oid);
}

export function normalizeGitObjectOid(oid: unknown): string | null {
  return isSafeGitObjectOid(oid) ? oid : null;
}

export function isSafeGitDiffIndexOid(oid: unknown): oid is string {
  return typeof oid === 'string' && /^[0-9a-f]{4,64}$/i.test(oid);
}

export function normalizeGitDiffIndexOid(oid: unknown): string | null {
  return isSafeGitDiffIndexOid(oid) ? oid : null;
}
