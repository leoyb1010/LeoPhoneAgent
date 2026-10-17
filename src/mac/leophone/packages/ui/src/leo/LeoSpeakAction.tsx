import { Square, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

import { MessageAction } from "@/components/ai-elements/message.js";
import { logger } from "@/logger.js";

import { leoSpeechBridge } from "./leoSpeechBridge.js";

/**
 * [leo][WP-60] 回复动作栏的「朗读」:用系统 AVSpeechSynthesizer 念这条回复(代码块跳过),再点停止。
 * 只在 macOS 桌面端且设置里没关朗读时出现。
 */
export function LeoSpeakAction({ text }: { text: string }) {
  const bridge = leoSpeechBridge();
  const [enabled, setEnabled] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [mine, setMine] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge
      .getSettings()
      .then((result) => {
        if (alive) setEnabled(Boolean(result.available && result.settings?.readAloudEnabled));
      })
      .catch(() => undefined);
    const off = bridge.onSpeakState((state) => {
      setSpeaking(state.speaking);
      if (!state.speaking) setMine(false);
    });
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  if (!bridge || !enabled || !text.trim()) return null;
  const active = speaking && mine;
  const label = active ? "停止朗读" : "朗读";
  return (
    <MessageAction
      aria-label={label}
      aria-pressed={active}
      label={label}
      tooltip={label}
      onClick={() => {
        if (active) {
          void bridge.stopSpeaking();
          return;
        }
        setMine(true);
        void bridge.speak(text).then((result) => {
          if (!result.ok) {
            setMine(false);
            logger.warn("[LeoSpeakAction] 朗读失败", result.error);
          }
        });
      }}
    >
      {active ? <Square className="size-3" /> : <Volume2 className="size-3.5" />}
    </MessageAction>
  );
}
