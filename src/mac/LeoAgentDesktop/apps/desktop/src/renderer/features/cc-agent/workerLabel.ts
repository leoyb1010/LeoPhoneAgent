export function createWorkerLabel(role: string, existingLabels: readonly string[]): string {
  const base = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'worker';
  const existing = new Set(existingLabels.map((label) => label.toLowerCase()));
  if (!existing.has(base)) return base;

  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }

  return `${base.slice(0, 27)}-${Date.now().toString(36).slice(-4)}`;
}

export function shouldShowWorkerLabel(role: string, label: string | null | undefined): label is string {
  return typeof label === 'string' && label.length > 0 && label !== role;
}
