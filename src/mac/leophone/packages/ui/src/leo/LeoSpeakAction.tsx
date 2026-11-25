import { Square, Volume2 } from "lucide-react";
import { useId, useSyncExternalStore } from "react";

import { MessageAction } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

import { leoSpeechBridge } from "./leoSpeechBridge.js";

interface SharedSpeakSnapshot {
  enabled: boolean;
  speaking: boolean;
  activeOwnerId: string | null;
}

const DISABLED_SNAPSHOT: SharedSpeakSnapshot = {
  enabled: false,
  speaking: false,
  activeOwnerId: null,
};

let currentBridge: ReturnType<typeof leoSpeechBridge> = null;
let sharedSnapshot: SharedSpeakSnapshot = DISABLED_SNAPSHOT;
let pendingOwnerId: string | null = null;
let unsubscribeBridge: (() => void) | null = null;
let unsubscribeSettingsEvent: (() => void) | null = null;
const listeners = new Set<() => void>();

function emitSnapshot(next: SharedSpeakSnapshot) {
  if (
    sharedSnapshot.enabled === next.enabled &&
    sharedSnapshot.speaking === next.speaking &&
    sharedSnapshot.activeOwnerId === next.activeOwnerId
  ) {
    return;
  }
  sharedSnapshot = next;
  for (const listener of listeners) listener();
}

function refreshSharedSettings(bridge: NonNullable<ReturnType<typeof leoSpeechBridge>>) {
  void bridge
    .getSettings()
    .then((result) => {
      if (currentBridge !== bridge) return;
      emitSnapshot({
        ...sharedSnapshot,
        enabled: Boolean(result.available && result.settings?.readAloudEnabled),
      });
    })
    .catch(() => undefined);
}

function subscribeSharedSpeak(
  bridge: ReturnType<typeof leoSpeechBridge>,
  listener: () => void,
): () => void {
  if (!bridge) return () => undefined;
  listeners.add(listener);
  if (currentBridge !== bridge) {
    unsubscribeBridge?.();
    unsubscribeSettingsEvent?.();
    currentBridge = bridge;
    sharedSnapshot = { enabled: false, speaking: false, activeOwnerId: null };
    pendingOwnerId = null;
    refreshSharedSettings(bridge);
    unsubscribeBridge = bridge.onSpeakState((state) => {
      if (currentBridge !== bridge) return;
      if (state.speaking) {
        const owner = pendingOwnerId ?? sharedSnapshot.activeOwnerId;
        pendingOwnerId = null;
        emitSnapshot({ ...sharedSnapshot, speaking: true, activeOwnerId: owner });
      } else if (pendingOwnerId !== null) {
        // 正在切换朗读到新消息时，主进程会先广播旧消息的 speaking:false；保留 pendingOwnerId，不抹掉新消息的停止态。
        emitSnapshot({ ...sharedSnapshot, speaking: false });
      } else {
        emitSnapshot({ ...sharedSnapshot, speaking: false, activeOwnerId: null });
      }
    });
    const onSettingsChanged = () => refreshSharedSettings(bridge);
    window.addEventListener("leo-speech-settings-changed", onSettingsChanged);
    unsubscribeSettingsEvent = () => {
      window.removeEventListener("leo-speech-settings-changed", onSettingsChanged);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      unsubscribeSettingsEvent?.();
      unsubscribeSettingsEvent = null;
      currentBridge = null;
      pendingOwnerId = null;
    }
  };
}

/**
 * [leo][WP-60] 回复动作栏的「朗读」:用系统 AVSpeechSynthesizer 念这条回复(代码块跳过),再点停止。
 * 所有消息行共享单一设置查询与事件订阅，避免每条消息重复注册 ipcRenderer 监听器。
 */
export function LeoSpeakAction({ text }: { text: string }) {
  const bridge = leoSpeechBridge();
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const ownerId = useId();
  const state = useSyncExternalStore(
    (listener) => subscribeSharedSpeak(bridge, listener),
    () => (bridge ? sharedSnapshot : DISABLED_SNAPSHOT),
    () => DISABLED_SNAPSHOT,
  );

  if (!bridge || !state.enabled || !text.trim()) return null;
  const active = (state.speaking && state.activeOwnerId === ownerId) || pendingOwnerId === ownerId;
  const label = active ? (zh ? "停止朗读" : "Stop reading") : zh ? "朗读" : "Read aloud";
  return (
    <MessageAction
      aria-label={label}
      aria-pressed={active}
      label={label}
      tooltip={label}
      onClick={() => {
        if (active) {
          pendingOwnerId = null;
          void bridge.stopSpeaking().catch(() => undefined);
          return;
        }
        pendingOwnerId = ownerId;
        emitSnapshot({ ...sharedSnapshot, activeOwnerId: ownerId });
        void bridge
          .speak(text)
          .then((result) => {
            if (!result.ok) {
              if (pendingOwnerId === ownerId) pendingOwnerId = null;
              if (sharedSnapshot.activeOwnerId === ownerId) {
                emitSnapshot({ ...sharedSnapshot, speaking: false, activeOwnerId: null });
              }
              logger.warn("[LeoSpeakAction] 朗读失败", result.error);
            }
          })
          .catch((error: unknown) => {
            if (pendingOwnerId === ownerId) pendingOwnerId = null;
            if (sharedSnapshot.activeOwnerId === ownerId) {
              emitSnapshot({ ...sharedSnapshot, speaking: false, activeOwnerId: null });
            }
            logger.warn("[LeoSpeakAction] 朗读异常", error);
          });
      }}
    >
      {active ? <Square className="size-3" /> : <Volume2 className="size-3.5" />}
    </MessageAction>
  );
}
