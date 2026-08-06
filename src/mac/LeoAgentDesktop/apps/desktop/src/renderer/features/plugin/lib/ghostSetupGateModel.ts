/**
 * Setup gate presentation model for the plugin "use" pre-flight dialog.
 *
 * Inputs: the host-evaluated GhostSetupStatus and the i18n translator.
 * Outputs: the dialog description string (missing vs reauth wording).
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { GhostSetupStatus } from '../../../../shared/ghost';

type Translator = (key: string, options?: Record<string, unknown>) => string;

/**
 * 就绪弹窗正文:缺失组按「组内任一 / 组间全部」口径拼接;仅剩账号过期时
 * 换「重新连接」话术。条目 label 来自清单声明原文(作者写什么显示什么,
 * 不进 i18n);分隔符走 i18n(各语言的「或」与列表顿号不同)。
 */
export function formatSetupGateDescription(status: GhostSetupStatus, t: Translator): string {
  const anySep = t('settings.ghosts.setupGate.anySeparator');
  const groupSep = t('settings.ghosts.setupGate.groupSeparator');
  if (status.missingGroups.length > 0) {
    const items = [
      ...status.missingGroups.map((group) => group.map((item) => item.label).join(anySep)),
      ...status.reauth.map((item) => item.label),
    ].join(groupSep);
    return t('settings.ghosts.setupGate.descriptionMissing', { items });
  }
  const items = status.reauth.map((item) => item.label).join(groupSep);
  return t('settings.ghosts.setupGate.descriptionReauth', { items });
}
