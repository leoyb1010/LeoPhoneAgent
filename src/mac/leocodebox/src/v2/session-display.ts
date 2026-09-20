export function displayAddedToast(): string {
  return '插上了一块屏幕。';
}

export function displayRemovedToast(): string {
  return '拔掉了一块屏幕。';
}

export function displayChangeToast(kind?: string | null): string {
  return kind === 'removed' ? displayRemovedToast() : displayAddedToast();
}
