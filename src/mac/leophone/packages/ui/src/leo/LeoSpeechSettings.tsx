import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsRow.js";
import { setShortcutRecordingActive } from "@/shortcuts/bindings.js";

import { leoSpeechBridge, type LeoSpeechSettings as Settings } from "./leoSpeechBridge.js";
import { acceleratorFromKeyEvent, formatAccelerator } from "./quickEntryAccelerator.js";

/**
 * [leo][WP-60] 设置 → 键盘快捷键里的「语音」块(macOS 桌面端):按住说话开关与键位、回复朗读开关。
 * 语音全部在本机完成(系统 SpeechAnalyzer / AVSpeechSynthesizer),不上传音频。
 */
export function LeoSpeechSettings() {
  const bridge = leoSpeechBridge();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge
      .getSettings()
      .then((result) => {
        if (result.settings) setSettings(result.settings);
        setAvailable(result.available !== false);
      })
      .catch((error: unknown) => logger.warn("[LeoSpeechSettings] 读取失败", error));
  }, [bridge]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      if (!bridge) return;
      const result = await bridge.setSettings(patch);
      if (result.settings) setSettings(result.settings);
      setMessage(result.error ?? null);
      window.dispatchEvent(new Event("leo-speech-settings-changed"));
    },
    [bridge],
  );

  useEffect(() => {
    if (!recording) return;
    setShortcutRecordingActive(true);
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorFromKeyEvent(event);
      if (!accelerator) return;
      setRecording(false);
      void update({ accelerator });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      setShortcutRecordingActive(false);
    };
  }, [recording, update]);

  if (!bridge || !settings) return null;
  return (
    <div
      className="overflow-hidden rounded-xl border border-border"
      data-testid="leo-speech-settings"
    >
      {!available ? (
        <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
          这个版本没有带语音助手（开发环境请先运行{" "}
          <code className="font-mono">pnpm leo:build-speech</code>）。
        </div>
      ) : null}
      <SettingsRow
        label="按住说话"
        description={`在 LeoBot 窗口里按住 ${formatAccelerator(settings.accelerator)} 说话，文字实时写进输入框，松开结束。本机识别，不上传。`}
        control={
          <Switch
            checked={settings.dictationEnabled}
            disabled={!available}
            onCheckedChange={(checked) => void update({ dictationEnabled: checked })}
            aria-label="按住说话"
          />
        }
      />
      {settings.dictationEnabled ? (
        <SettingsRow
          label="说话快捷键"
          description={
            message ? (
              <span className="text-[var(--leo-attention)]" role="status">
                {message}
              </span>
            ) : (
              "需要至少一个 ⌘ / ⌃ / ⌥。"
            )
          }
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={recording}
              disabled={!available}
              onClick={() => setRecording((value) => !value)}
            >
              {recording ? "按下新的组合键…" : formatAccelerator(settings.accelerator)}
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        label="朗读回复"
        description="回复下方出现朗读按钮，用系统语音念出来（代码块跳过）。"
        control={
          <Switch
            checked={settings.readAloudEnabled}
            disabled={!available}
            onCheckedChange={(checked) => void update({ readAloudEnabled: checked })}
            aria-label="朗读回复"
          />
        }
      />
    </div>
  );
}
