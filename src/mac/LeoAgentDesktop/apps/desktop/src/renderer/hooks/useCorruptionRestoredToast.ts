/**
 * chat-data-localization F1 V0.4 / M-FE6：corruption 恢复后一次性 toast。
 *
 * - main 在 ensureReady 成功执行两级回落（.bak.clean → .bak.{ISO}）后，
 *   通过 `local-db:corruption-restored` IPC event 推 `{source, backupMtime}`
 * - renderer 在主界面挂载时挂载本 hook，收到事件 → 显示一次性 toast
 * - 同一 renderer 会话内只显示一次（sessionStorage flag 去重）。下次启动重新评估。
 *
 * 文案：「数据库已从 {YYYY-MM-DD HH:mm} 的快照恢复，期间的聊天可能丢失」
 *      （时间格式化为本地时区到分钟）
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { i18n } from '@/i18n';

const SHOWN_FLAG_KEY = 'corruption-restored-toast-shown';

export function useCorruptionRestoredToast(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const unsubscribe = window.electronAPI.localDb.onCorruptionRestored((info) => {
      try {
        if (sessionStorage.getItem(SHOWN_FLAG_KEY) === '1') return;
        sessionStorage.setItem(SHOWN_FLAG_KEY, '1');
      } catch {
        // sessionStorage 不可用时也别静默吃掉提示，继续显示
      }

      const formatted = formatLocalDateTime(new Date(info.backupMtime));
      // 项目 toast API 是 message-only（toast.warning(msg, opts)）；
      // 用 warning 变体——既不是危险错误，也不是日常成功。
      toast.warning(
        t('logic.toasts.corruptionRestored', { time: formatted }),
        { duration: 8000 },
      );
    });

    return unsubscribe;
  }, [t]);
}

function formatLocalDateTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return i18n.t('logic.time.unknown');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
