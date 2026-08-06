/**
 * codexAuthSync — Codex auth.json 同步流程的共用 UI 工具。
 * ---------------------------------------------------------------------------
 * 既被 Settings (RemoteHostDetail) 用, 也被 ChatView 的 ErrorBanner 用。
 * 两个入口共享同一套警告文案 + 同一个 check → confirm → sync 三步顺序, 避免
 * "Settings 走 confirm 但 chat banner 直接覆盖" 这种安全/UX 不一致。
 */

export function formatRelativeTime(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const days = Math.floor(diffMs / 86_400_000);
  if (days >= 1) return t('settings.remote.codexSync.daysAgo', { n: days });
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours >= 1) return t('settings.remote.codexSync.hoursAgo', { n: hours });
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes >= 1) return t('settings.remote.codexSync.minutesAgo', { n: minutes });
  return t('settings.remote.codexSync.justNow');
}

/**
 * 同步前展示的警告文本 (传给 confirm dialog 的 description)。
 * - 远端没 auth.json: 显首次推送 + "共享 SSH 账号 = 凭证可能被偷" 安全提示
 * - 远端已有 auth.json: 额外加 "会覆盖现有登录" 警告 + 已有登录的时间
 */
export function buildCodexSyncWarning(
  hostId: string,
  remoteExists: boolean,
  remoteMtime: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const securityLine = t('settings.remote.codexSync.warnShared', { hostId });
  if (!remoteExists) {
    return [
      t('settings.remote.codexSync.descFirstPush', { hostId }),
      '',
      `⚠️ ${securityLine}`,
    ].join('\n');
  }
  const ageLine = remoteMtime
    ? t('settings.remote.codexSync.descOverwriteWithAge', {
        hostId,
        when: formatRelativeTime(remoteMtime, t),
      })
    : t('settings.remote.codexSync.descOverwrite', { hostId });
  return [
    ageLine,
    '',
    `⚠️ ${t('settings.remote.codexSync.warnOverwrite')}`,
    '',
    `⚠️ ${securityLine}`,
  ].join('\n');
}
