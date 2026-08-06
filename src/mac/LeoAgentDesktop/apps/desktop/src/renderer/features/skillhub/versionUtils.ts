/** Bump patch segment of a semver-like version string. Mirrors server-side `determineNextVersion`. */
export function bumpPatch(version: string | null | undefined): string {
  if (!version) return '1.0.0';
  const parts = version.split('.').map(Number);
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
  return '1.0.0';
}

function plainSemverCompare(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number(part));
  const pb = b.split('.').map((part) => Number(part));
  for (let i = 0; i < 3; i++) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    const diff = av - bv;
    if (diff !== 0) return diff;
  }
  return 0;
}

function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v(?=\d)/i, '');
}

function migratedLegacyVersion(version: string): string | null {
  const normalized = stripVersionPrefix(version);
  if (!/^\d+$/.test(normalized)) return null;
  return `1.0.${Number(normalized)}`;
}

/** Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
export function semverCompare(a: string, b: string): number {
  const normalizedA = stripVersionPrefix(a);
  const normalizedB = stripVersionPrefix(b);
  const migratedA = migratedLegacyVersion(normalizedA);
  const migratedB = migratedLegacyVersion(normalizedB);
  if (migratedA && migratedA === normalizedB) return 0;
  if (migratedB && migratedB === normalizedA) return 0;
  return plainSemverCompare(normalizedA, normalizedB);
}

export function latestKnownVersion(
  latestVersion: string | null | undefined,
  pendingVersion?: { version?: string | null; status?: string | null } | null,
  latestVersionStatus?: string | null,
): string | null {
  const occupiedLatestVersion = isOccupiedPendingVersion(latestVersionStatus)
    ? latestVersion
    : null;
  const occupiedPendingVersion = isOccupiedPendingVersion(pendingVersion?.status)
    ? pendingVersion?.version
    : null;
  const candidates = [occupiedLatestVersion, occupiedPendingVersion]
    .map((version) => version?.trim())
    .filter((version): version is string => Boolean(version));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, version) =>
    plainSemverCompare(version, best) > 0 ? version : best);
}

function isOccupiedPendingVersion(status: string | null | undefined): boolean {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === 'rejected' || normalized === 'failed' || normalized === 'fail' || normalized === 'blocked') {
    return false;
  }
  return true;
}

function reusableLatestVersion(
  latestVersion: string | null | undefined,
  latestVersionStatus: string | null | undefined,
): string | null {
  const normalized = latestVersion?.trim();
  if (!normalized || !isDottedVersion(normalized)) return null;
  return isOccupiedPendingVersion(latestVersionStatus) ? null : normalized;
}

function isDottedVersion(version: string): boolean {
  const parts = version.split('.').map(Number);
  return parts.length === 3 && parts.every((n) => !Number.isNaN(n));
}

/** Pick the higher of frontmatter version and the next unoccupied server version. */
export function pickDefaultVersion(
  frontmatterVersion: string | undefined,
  latestVersion: string | null | undefined,
  pendingVersion?: { version?: string | null; status?: string | null } | null,
  latestVersionStatus?: string | null,
): string {
  const bumped = bumpPatch(latestKnownVersion(latestVersion, pendingVersion, latestVersionStatus));
  const reusableLatest = reusableLatestVersion(latestVersion, latestVersionStatus);
  const defaultVersion =
    reusableLatest && plainSemverCompare(reusableLatest, bumped) > 0 ? reusableLatest : bumped;
  if (!frontmatterVersion) return defaultVersion;
  return plainSemverCompare(frontmatterVersion, defaultVersion) >= 0 ? frontmatterVersion : defaultVersion;
}
