export function canShowEmoji(desktop?: { showEmojiPanel?: unknown } | null): boolean {
  return Boolean(desktop?.showEmojiPanel);
}

export function emojiLabel(): string {
  return '弹出表情';
}

export function emojiToast(): string {
  return '已弹出表情';
}
