import { stripTrailingPathSeparators } from '../../../../shared/pathText';

function usesWindowsSeparator(pathValue: string): boolean {
  return pathValue.includes('\\') && !pathValue.includes('/');
}

function trimTrailingSeparators(pathValue: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(pathValue)) return pathValue;
  if (pathValue === '/' || pathValue === '\\') return pathValue;
  return stripTrailingPathSeparators(pathValue);
}

function isWindowsNormalizedPath(pathValue: string): boolean {
  return /^[A-Za-z]:\//.test(pathValue);
}

export function normalizeInstallPathKey(pathValue: string): string {
  let normalized = pathValue.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  normalized = trimTrailingSeparators(normalized);
  return isWindowsNormalizedPath(normalized) ? normalized.toLowerCase() : normalized;
}

export function joinSkillInstallPath(baseDir: string, skillName: string): string {
  const base = trimTrailingSeparators(baseDir);
  const sep = usesWindowsSeparator(base) ? '\\' : '/';
  return [base, '.agents', 'skills', skillName].join(sep);
}

export function isInstallPathForSkill(pathValue: string, skillName: string): boolean {
  const normalized = normalizeInstallPathKey(pathValue);
  const suffix = `/.agents/skills/${skillName}`;
  return normalized.endsWith(isWindowsNormalizedPath(normalized) ? suffix.toLowerCase() : suffix);
}

export function isInstallPathUnderProject(pathValue: string, projectRoot: string): boolean {
  const normalizedPath = normalizeInstallPathKey(pathValue);
  const normalizedRoot = normalizeInstallPathKey(projectRoot);
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}
