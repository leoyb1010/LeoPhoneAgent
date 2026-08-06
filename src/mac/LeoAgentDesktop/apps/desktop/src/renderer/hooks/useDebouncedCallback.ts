/**
 * useDebouncedCallback — 通用防抖 hook（无 lodash 依赖）
 * ---------------------------------------------------------------------------
 * 返回一个稳定引用的防抖函数：调用频率被压缩为「最后一次调用 + delay」触发一次。
 *
 * 设计要点：
 *  - 用 ref 存最新 callback，避免每次 callback 引用变都重建 timer
 *  - 卸载时清掉未触发的 timer，防止 setState on unmounted
 *  - 暴露 cancel() 方便业务侧主动撤销待触发
 */

import { useCallback, useEffect, useRef } from 'react';

type AnyFn = (...args: never[]) => void;

export interface DebouncedFn<T extends AnyFn> {
  (...args: Parameters<T>): void;
  cancel: () => void;
}

export function useDebouncedCallback<T extends AnyFn>(
  callback: T,
  delay = 200,
): DebouncedFn<T> {
  const callbackRef = useRef<T>(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const debounced = useCallback(
    (...args: Parameters<T>) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        callbackRef.current(...(args as Parameters<T>));
      }, delay);
    },
    [delay],
  ) as DebouncedFn<T>;

  debounced.cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return debounced;
}
