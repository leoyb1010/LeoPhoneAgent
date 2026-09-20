export function missingCwdToast(): string {
  return '这个目录已经不在了。';
}

export async function isMissingSessionCwd(
  raw?: string | null,
  desktop?: { cwdExists?: (target: string) => Promise<{ exists?: boolean }> } | null,
): Promise<boolean> {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  const probe = desktop?.cwdExists;
  if (!probe) return false;
  const row = await probe(text);
  return row?.exists === false;
}
