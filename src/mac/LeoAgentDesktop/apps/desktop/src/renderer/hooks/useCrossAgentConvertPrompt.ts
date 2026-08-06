/**
 * useCrossAgentMigrationDialog
 *
 * 弹窗 + 状态机 + 进度订阅 + Promise 等待。
 *
 * 使用方式：
 *   const dialog = useCrossAgentMigrationDialog();
 *   await dialog.runMigrationFlow(items); // resolve 时弹窗已关闭（用户取消 / 完成 / 全失败）
 *   <CrossAgentConvertDialog {...dialog} />
 *
 * 状态机：
 *   'closed' → show(items) → 'asking'
 *     ↓ user 不要              ↓ user 转换
 *   'closed'(已 resolve)      'running' → 完成 → 'closed'(已 resolve)
 *
 * running 期间 onOpenChange(false) 被忽略；ESC / 点遮罩失效（在 dialog 组件层处理）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { crossAgentConvertService } from '@/lib/crossAgentConvertService';

const log = createLogger('useCrossAgentMigrationDialog');

export type DialogPhase = 'asking' | 'running' | 'closed';

export interface CrossAgentMigrationDialogState {
  open: boolean;
  phase: DialogPhase;
  items: CrossAgentMigrationItem[];
  stepMap: Record<string, { status: CrossAgentStepStatus; detail?: string }>;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export interface UseCrossAgentMigrationDialogResult extends CrossAgentMigrationDialogState {
  /**
   * 启动一次"询问 + 转换"流程。返回 Promise，弹窗关闭（用户决定 + 可能完成转换）后 resolve。
   * 若 items 为空 → 立即 resolve，不弹窗。
   */
  runMigrationFlow: (items: CrossAgentMigrationItem[]) => Promise<void>;
}

export function useCrossAgentMigrationDialog(): UseCrossAgentMigrationDialogResult {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<DialogPhase>('closed');
  const [items, setItems] = useState<CrossAgentMigrationItem[]>([]);
  const [stepMap, setStepMap] = useState<Record<string, { status: CrossAgentStepStatus; detail?: string }>>({});

  // resolver 给 runMigrationFlow 的 Promise 用 —— 在弹窗最终关闭时调用
  const resolverRef = useRef<(() => void) | null>(null);
  const finishFlow = useCallback(() => {
    setOpen(false);
    setPhase('closed');
    if (resolverRef.current) {
      resolverRef.current();
      resolverRef.current = null;
    }
  }, []);

  // 订阅 step push（生命周期内一次）
  useEffect(() => {
    const unsub = crossAgentConvertService.onStep((ev) => {
      setStepMap((prev) => ({ ...prev, [ev.itemId]: { status: ev.status, detail: ev.detail } }));
    });
    return unsub;
  }, []);

  const runMigrationFlow = useCallback((nextItems: CrossAgentMigrationItem[]): Promise<void> => {
    if (!nextItems || nextItems.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resolverRef.current = resolve;
      const initial: Record<string, { status: CrossAgentStepStatus }> = {};
      for (const it of nextItems) initial[it.id] = { status: 'pending' };
      setItems(nextItems);
      setStepMap(initial);
      setPhase('asking');
      setOpen(true);
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (phase !== 'asking' || items.length === 0) return;
    setPhase('running');
    crossAgentConvertService
      .convert(items)
      .then((summary) => {
        const { successCount, skippedCount, failedCount, total } = summary;
        if (failedCount === 0) {
          toast.success(
            successCount > 0
              ? t('logic.toasts.migrationDoneAll', {
                  success: successCount,
                  skipSuffix:
                    skippedCount > 0
                      ? t('logic.toasts.migrationSkipSuffix', { skipped: skippedCount })
                      : '',
                })
              : t('logic.toasts.migrationNoneNeeded'),
          );
        } else {
          toast.warning(
            t('logic.toasts.migrationPartial', {
              success: successCount,
              skipped: skippedCount,
              failed: failedCount,
              total,
            }),
          );
        }
        finishFlow();
      })
      .catch((err) => {
        log.error('[convert] failed', err);
        toast.error(t('logic.toasts.migrationFailed'));
        // 失败也视为流程结束 → resolve，让用户进会话；步骤里失败状态已留痕在 toast
        finishFlow();
      });
  }, [phase, items, finishFlow, t]);

  const handleCancel = useCallback(() => {
    if (phase !== 'asking') return;
    finishFlow();
  }, [phase, finishFlow]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (phase === 'running') return; // 锁死
      if (!next) finishFlow();
      else setOpen(next);
    },
    [phase, finishFlow],
  );

  return {
    open,
    phase,
    items,
    stepMap,
    onOpenChange,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
    runMigrationFlow,
  };
}
