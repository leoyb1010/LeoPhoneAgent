/**
 * RemoteSessionLoading —— 远程会话首屏「正在从被控端加载」覆盖层(控制端)。
 *
 * 仅在 device-link 远程会话首拉(historyLoaded=false)且超过防闪延迟时,由
 * CCAgentSessionView 覆盖在空消息区之上,让控制端明确「在等被控端」而非空会话。
 * historyLoaded 翻 true 即由上层卸载,平滑接上消息流。颜色走主题 token,不硬编码。
 */

import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';

export function RemoteSessionLoading() {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="flex items-center gap-2 text-13 text-[var(--text-secondary)]">
        <Spinner size={14} />
        <span>{t('ccAgent.remoteSession.loading')}</span>
      </div>
    </div>
  );
}
