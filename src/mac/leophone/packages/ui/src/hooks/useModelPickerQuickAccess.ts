/**
 * 模型选择器「常用 / 最近使用」的读写入口。
 *
 * 事实源是 AppSettings（Setting Service，跨重启、按 Environment 隔离），这里不另存副本：
 * - 常用只由星标 `togglePinned` 写；
 * - 最近使用只由 Composer 发送被接受后 `recordModelUsed` 写（见 docs/specs/leo-model-picker.md）。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSettings } from "./useSettingService.js";
import { logger } from "@/logger.js";
import {
  MODEL_PICKER_MAX_PINNED,
  MODEL_PICKER_RECENT_STORED,
  isSameModelValueList,
  recordRecentModel,
  sanitizeModelValueList,
  togglePinnedModel,
} from "@/lib/modelPickerQuickAccess.js";

export interface ModelPickerQuickAccess {
  pinnedValues: readonly string[];
  recentValues: readonly string[];
  maxPinned: number;
  togglePinned: (value: string) => void;
}

function useModelPickerLists() {
  const { settings, update } = useSettings();
  const pinnedValues = useMemo(
    () => sanitizeModelValueList(settings?.modelPickerPinnedValues, MODEL_PICKER_MAX_PINNED),
    [settings?.modelPickerPinnedValues],
  );
  const recentValues = useMemo(
    () => sanitizeModelValueList(settings?.modelPickerRecentValues, MODEL_PICKER_RECENT_STORED),
    [settings?.modelPickerRecentValues],
  );
  // 连续两次写入可能早于快照刷新；用 ref 读最新值，避免第二次基于旧列表覆盖第一次。
  const latestRef = useRef({ pinnedValues, recentValues });
  useEffect(() => {
    latestRef.current = { pinnedValues, recentValues };
  }, [pinnedValues, recentValues]);
  return { pinnedValues, recentValues, latestRef, update };
}

export function useModelPickerQuickAccess(): ModelPickerQuickAccess {
  const { pinnedValues, recentValues, latestRef, update } = useModelPickerLists();
  const togglePinned = useCallback(
    (value: string) => {
      const result = togglePinnedModel(latestRef.current.pinnedValues, value);
      if (result.status === "full") return;
      latestRef.current = { ...latestRef.current, pinnedValues: result.pinned };
      void update({ modelPickerPinnedValues: result.pinned }).catch((error: unknown) => {
        logger.warn("[model-picker] 保存常用模型失败", { error: String(error) });
      });
    },
    [latestRef, update],
  );
  return useMemo(
    () => ({ pinnedValues, recentValues, maxPinned: MODEL_PICKER_MAX_PINNED, togglePinned }),
    [pinnedValues, recentValues, togglePinned],
  );
}

/** 发送被接受后记录本次使用的模型；值为空或已在最前时不写盘。 */
export function useRecordModelUsed(): (value: string) => void {
  const { latestRef, update } = useModelPickerLists();
  return useCallback(
    (value: string) => {
      if (!value) return;
      const current = latestRef.current.recentValues;
      const next = recordRecentModel(current, value);
      if (isSameModelValueList(current, next)) return;
      latestRef.current = { ...latestRef.current, recentValues: next };
      void update({ modelPickerRecentValues: next }).catch((error: unknown) => {
        logger.warn("[model-picker] 记录最近使用模型失败", { error: String(error) });
      });
    },
    [latestRef, update],
  );
}
