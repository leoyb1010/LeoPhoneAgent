import { useCallback, useEffect, useRef, useState } from 'react';

import { createLogger } from '@/lib/logger';

const log = createLogger('UseCompactionSettings');

// main (compaction-settings-store) 是 clamp 的唯一 source of truth: compactionGetPct /
// compactionSetPct 的返回值已是 [50,95] 内的合法整数, Slider 也用 min/max/step 约束了
// 输入, 所以 renderer 不再重复 clamp。DEFAULT_PCT 仅作 IPC 读失败时的兜底。
const DEFAULT_PCT = 75;
const WRITE_DEBOUNCE_MS = 300;

export function useCompactionSettings(): {
  pct: number | null;
  isCustomized: boolean;
  defaultPct: number;
  setPct: (next: number) => void;
  resetPct: () => Promise<number>;
} {
  const [pct, setPctState] = useState<number | null>(null);
  const [isCustomized, setIsCustomized] = useState(false);
  const [defaultPct, setDefaultPct] = useState(DEFAULT_PCT);
  const mountedRef = useRef(false);
  const pendingPctRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadPct = useCallback(async () => {
    try {
      const next = await window.electronAPI.maker.compactionGetState();
      if (mountedRef.current) {
        setPctState(next.pct);
        setIsCustomized(next.isCustomized);
        setDefaultPct(next.defaultPct);
      }
    } catch (err) {
      log.warn('compactionGetPct failed', err);
      if (mountedRef.current) setPctState(DEFAULT_PCT);
    }
  }, []);

  const commitPct = useCallback(
    async (next: number) => {
      try {
        const state = await window.electronAPI.maker.compactionSetPct(next);
        if (mountedRef.current) {
          setPctState(state.pct);
          setIsCustomized(state.isCustomized);
          setDefaultPct(state.defaultPct);
        }
      } catch (err) {
        log.warn('compactionSetPct failed', err);
        await reloadPct();
      }
    },
    [reloadPct],
  );

  const setPct = useCallback(
    (next: number) => {
      setPctState(next);
      pendingPctRef.current = next;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingPctRef.current = null;
        void commitPct(next);
      }, WRITE_DEBOUNCE_MS);
    },
    [commitPct],
  );

  const resetPct = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingPctRef.current = null;
    const next = await window.electronAPI.maker.compactionResetPct();
    if (mountedRef.current) {
      setPctState(next.pct);
      setIsCustomized(next.isCustomized);
      setDefaultPct(next.defaultPct);
    }
    return next.pct;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void reloadPct();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const pending = pendingPctRef.current;
      pendingPctRef.current = null;
      if (pending !== null) {
        void window.electronAPI.maker.compactionSetPct(pending);
      }
    };
  }, [reloadPct]);

  return { pct, isCustomized, defaultPct, setPct, resetPct };
}
