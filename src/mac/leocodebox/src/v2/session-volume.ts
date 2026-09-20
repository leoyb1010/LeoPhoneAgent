export function volumeAddedToast(): string {
  return '插上了一块磁盘。';
}

export function volumeRemovedToast(): string {
  return '拔掉了一块磁盘。';
}

export function volumeChangeToast(kind?: string | null): string {
  return kind === 'removed' ? volumeRemovedToast() : volumeAddedToast();
}
