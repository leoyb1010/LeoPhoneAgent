import { Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { logger } from "@/logger.js";

import { DictationWriter, findDictationTarget } from "./dictationWriter.js";
import { leoSpeechBridge, type LeoSpeechEvent, type LeoSpeechSettings } from "./leoSpeechBridge.js";
import {
  acceleratorFromKeyEvent,
  formatAccelerator,
  isAcceleratorRelease,
} from "./quickEntryAccelerator.js";

/**
 * [leo][WP-60] 按住快捷键说话(默认 ⌥`):按下开始收音,边说边把文字写进当前输入框,松开收尾成最终文本。
 * 只在 LeoBot 窗口有焦点时生效(文字写进的就是这个窗口的输入框);窗口底部显示一个「正在听」小条。
 */

/** [wp-31] 工具条麦克风按钮 → 本组件:切换收音。收音状态只由本组件持有。 */
export const LEO_DICTATION_TOGGLE_EVENT = "leo-dictation-toggle";

type Phase =
  | { kind: "idle" }
  | { kind: "listening"; installing: boolean }
  | { kind: "finishing" }
  | { kind: "error"; message: string; micDenied: boolean };

export function LeoPushToTalk() {
  const bridge = leoSpeechBridge();
  const [settings, setSettings] = useState<LeoSpeechSettings | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const writerRef = useRef<DictationWriter | null>(null);
  const activeRef = useRef(false);
  const errorTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!bridge) return;
    const load = () =>
      bridge
        .getSettings()
        .then((result) => {
          if (result.settings) setSettings(result.available ? result.settings : null);
        })
        .catch((error: unknown) => logger.warn("[LeoPushToTalk] 读取语音设置失败", error));
    load();
    // 设置页改了开关 / 键位后,窗口回到前台时重读。
    window.addEventListener("focus", load);
    window.addEventListener("leo-speech-settings-changed", load);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener("leo-speech-settings-changed", load);
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((event: LeoSpeechEvent) => {
      if (event.type === "installing") setPhase({ kind: "listening", installing: true });
      else if (event.type === "ready") setPhase({ kind: "listening", installing: false });
      else if (event.type === "partial" || event.type === "final")
        writerRef.current?.update(event.text);
      else if (event.type === "error") {
        activeRef.current = false;
        setPhase({ kind: "error", message: event.message, micDenied: event.code === "mic_denied" });
        if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
        errorTimerRef.current = window.setTimeout(() => setPhase({ kind: "idle" }), 6_000);
      } else if (event.type === "done") {
        activeRef.current = false;
        writerRef.current = null;
        setPhase((current) => (current.kind === "error" ? current : { kind: "idle" }));
      }
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge || !settings?.dictationEnabled) return;
    const accelerator = settings.accelerator;
    const isHotkey = (event: KeyboardEvent) => acceleratorFromKeyEvent(event) === accelerator;
    const stop = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setPhase({ kind: "finishing" });
      void bridge.stop();
    };
    const begin = () => {
      const target = findDictationTarget();
      if (!target) {
        setPhase({ kind: "error", message: "先点一下输入框再说话", micDenied: false });
        return;
      }
      activeRef.current = true;
      writerRef.current = new DictationWriter(target);
      setPhase({ kind: "listening", installing: false });
      void bridge.start().then((result) => {
        if (!result.ok) {
          activeRef.current = false;
          setPhase({ kind: "error", message: result.error ?? "语音助手没启动", micDenied: false });
        }
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isHotkey(event)) return;
      // ⌥` 在美式键盘上是「重音符」死键:必须拦住,否则输入框里先冒出一个组字中的 `。
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || activeRef.current) return;
      begin();
    };
    // [wp-31] 输入框工具条的麦克风按钮:点一下开始,再点一下收尾。和快捷键共用同一条收音链路。
    const onToggle = () => {
      if (activeRef.current) stop();
      else begin();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      // 松开主键或组合里任一修饰键都算松手。
      if (isAcceleratorRelease(event, accelerator)) stop();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", stop);
    window.addEventListener(LEO_DICTATION_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", stop);
      window.removeEventListener(LEO_DICTATION_TOGGLE_EVENT, onToggle);
    };
  }, [bridge, settings]);

  if (!bridge || phase.kind === "idle") return null;
  const hint = settings ? formatAccelerator(settings.accelerator) : "";
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-popover px-4 py-2 text-ui-sm text-foreground shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none">
        {phase.kind === "error" ? (
          <>
            <span className="text-destructive">{phase.message}</span>
            {phase.micDenied ? (
              <button
                type="button"
                className="text-[var(--leo-brand)] underline-offset-2 hover:underline"
                onClick={() => void bridge.openMicSettings()}
              >
                去系统设置
              </button>
            ) : null}
          </>
        ) : (
          <>
            <Mic
              className="size-4 text-[var(--leo-brand)] animate-pulse motion-reduce:animate-none"
              aria-hidden="true"
            />
            {phase.kind === "finishing"
              ? "正在收尾…"
              : phase.installing
                ? "第一次使用，正在准备系统语音资源…"
                : `正在听…  松开 ${hint} 或再点麦克风结束`}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
