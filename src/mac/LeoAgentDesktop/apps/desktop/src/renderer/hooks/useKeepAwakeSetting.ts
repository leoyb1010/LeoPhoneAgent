/**
 * useKeepAwakeSetting —— 「保持电脑唤醒」开关的渲染层数据(独立于设备列表)。
 * ---------------------------------------------------------------------------
 * keepAwake 落在 device-link settings store(main 用 powerSaveBlocker 防休眠),
 * 但 UI 上归入「应用行为」section,与「远程控制 / 我的设备」不在同一个 tab。为避免
 * 在「应用行为」里挂上 useDeviceLinkSettings 那套 30s 设备列表轮询 / presence 订阅,
 * 这里只做最小数据层:挂载时读一次 getState 取初值 + setKeepAwake 走 IPC(乐观更新
 * + toast + 失败回滚)。跨实例同步由 main 的 5s 轮询负责(见 device-link/index.ts),
 * 渲染层只反映本进程当前值。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';

const log = createLogger('useKeepAwakeSetting');

export function useKeepAwakeSetting(): {
  keepAwake: boolean;
  setKeepAwake: (next: boolean) => Promise<void>;
} {
  const { t } = useTranslation();
  const [keepAwake, setKeepAwakeState] = useState(false);
  const mounted = useRef(true);
  // Skip stale initial load if the user has already toggled the switch locally.
  const hasLocalEdit = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void window.electronAPI?.deviceLink
      ?.getState()
      .then((s) => {
        if (mounted.current && !hasLocalEdit.current) setKeepAwakeState(s.keepAwake);
      })
      .catch((err) => log.warn('load keepAwake failed', err));
    const offKeepAwake = window.electronAPI?.deviceLink?.onKeepAwakeChanged?.((p) => {
      if (mounted.current) setKeepAwakeState(p.keepAwake);
    });
    return () => {
      mounted.current = false;
      offKeepAwake?.();
    };
  }, []);

  const setKeepAwake = useCallback(
    async (next: boolean) => {
      const prev = keepAwake;
      hasLocalEdit.current = true;
      setKeepAwakeState(next);
      try {
        await window.electronAPI.deviceLink.setKeepAwake(next);
        toast.success(
          t(next ? 'settings.devices.toast.keepAwakeOn' : 'settings.devices.toast.keepAwakeOff'),
        );
      } catch (err) {
        log.warn('setKeepAwake failed', err);
        setKeepAwakeState(prev);
        toast.error(t('settings.devices.toast.keepAwakeToggleFailed'));
      }
    },
    [keepAwake, t],
  );

  return { keepAwake, setKeepAwake };
}
