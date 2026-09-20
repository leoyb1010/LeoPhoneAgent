export function isBrowserOffline(nav?: { onLine?: boolean } | null): boolean {
  return nav?.onLine === false;
}

export function offlineToast(): string {
  return '现在断网了，模型先发不出去。';
}

export function onlineToast(): string {
  return '网回来了。';
}

export function offlineBanner(): string {
  return '现在断网了。';
}
