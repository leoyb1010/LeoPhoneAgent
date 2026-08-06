/**
 * #37 / schema-drift release-side toast。
 *
 * 触发场景:release 版启动时 schemaDriftDetector 发现本地 DB 的 migration 历史 hash
 * 不一致。已确认 schema 等价的历史 hash 会由 main 自动收敛;这里只展示仍未知的 drift。
 *
 * Release 端不会自动改 schema,toast 引导用户升级到最新版或联系支持,不要求普通用户
 * 安装 dev 版本。dev 端的 schemaDriftRepair 仍会自动反射 schema.ts 补缺列/缺表/缺索引。
 *
 * 同 session 内只显示一次(sessionStorage flag 去重)。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';

const SHOWN_FLAG_KEY = 'schema-drift-warning-toast-shown';

export function useSchemaDriftWarningToast(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const unsubscribe = window.electronAPI.localDb.onSchemaDriftWarning(() => {
      try {
        if (sessionStorage.getItem(SHOWN_FLAG_KEY) === '1') return;
        sessionStorage.setItem(SHOWN_FLAG_KEY, '1');
      } catch {
        // sessionStorage 不可用时也别静默吃掉提示
      }
      toast.warning(t('logic.toasts.schemaDriftWarning'), { duration: 10000 });
    });
    return unsubscribe;
  }, [t]);
}
