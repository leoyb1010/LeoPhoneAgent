function hashName(name: string): string {
  let hash = 2166136261;
  for (const char of name.normalize('NFKC')) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return s || `provider-${hashName(name)}`;
}

export function uniqueCustomProviderId(name: string, existing: ReadonlySet<string>): string {
  const base = slugify(name);
  if (!existing.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}
