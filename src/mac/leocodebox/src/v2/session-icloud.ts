export function isIcloudPath(raw?: string | null): boolean {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  return /(?:^|\/)Library\/Mobile Documents\//i.test(text)
    || /(?:^|\/)Mobile Documents\//i.test(text)
    || /com~apple~CloudDocs/i.test(text)
    || /\/iCloud Drive(?:\/|$)/i.test(text);
}

export function icloudCwdToast(): string {
  return '这个目录在 iCloud 里，同步可能拖慢或打架。';
}
