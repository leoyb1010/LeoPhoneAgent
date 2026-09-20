export function canOpenAccessibility(desktop?: { openAccessibility?: unknown } | null): boolean {
  return Boolean(desktop?.openAccessibility);
}

export function openAccessibilityLabel(): string {
  return '去开辅助功能';
}

export function openAccessibilityToast(): string {
  return '已打开辅助功能设置';
}
