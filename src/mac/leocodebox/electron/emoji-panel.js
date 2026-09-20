export function canShowEmojiPanel(appLike, platform = process.platform) {
  return platform === 'darwin' && typeof appLike?.showEmojiPanel === 'function';
}

export function showEmojiPanel(appLike, platform = process.platform) {
  if (!canShowEmojiPanel(appLike, platform)) throw new Error('这台电脑现在弹不出表情');
  appLike.showEmojiPanel();
  return { ok: true };
}
