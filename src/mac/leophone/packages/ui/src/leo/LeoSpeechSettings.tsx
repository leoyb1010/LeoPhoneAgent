import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
  const platform = useOptionalPlatform();
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [available, setAvailable] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge
      .getSettings()
      .then((result) => {
        if (!alive) return;
        if (result.settings) setSettings(result.settings);
        setAvailable(result.available !== false);
      })
      .catch((error: unknown) => logger.warn("[LeoSpeechSettings] 读取失败", error));
    return () => {
      alive = false;
    };
  }, [bridge]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      if (!bridge) return;
      setSaving(true);
      try {
        const result = await bridge.setSettings(patch);
        if (!mountedRef.current) return;
        if (result.settings) setSettings(result.settings);
        setMessage(result.error ?? null);
        window.dispatchEvent(new Event("leo-speech-settings-changed"));
      } catch (error) {
        logger.warn("[LeoSpeechSettings] 保存失败", error);
        if (mountedRef.current) {
          setMessage(zh ? "保存失败，请查看日志" : "Failed to save settings. Check logs.");
        }
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [bridge, zh],
  );

  useEffect(() => {
    if (!recording) return;
    setShortcutRecordingActive(true);
    void platform?.setShortcutRecordingActive?.(true);
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
      void platform?.setShortcutRecordingActive?.(false);
    };
  }, [platform, recording, update]);

  if (!bridge || !settings) return null;
  const currentShortcut = formatAccelerator(settings.accelerator);
  return (
    <div
      className="overflow-hidden rounded-xl border border-border"
      data-testid="leo-speech-settings"
    >
      {!available ? (
        <div className="px-4 py-3 text-ui-sm text-foreground-subtle">
          {zh ? (
            <>
              这个版本没有带语音助手（开发环境请先运行{" "}
              <code className="font-mono">pnpm leo:build-speech</code>）。
            </>
          ) : (
            <>
              Voice helper is not bundled in this build (run{" "}
              <code className="font-mono">pnpm leo:build-speech</code> in dev).
            </>
          )}
        </div>
      ) : null}
      <SettingsRow
        label={zh ? "按住说话" : "Push to talk"}
        description={
          zh
            ? `在 LeoBot 窗口里按住 ${currentShortcut} 说话，文字实时写进输入框，松开结束。本机识别，不上传。`
            : `Hold ${currentShortcut} in LeoBot to dictate live into the input box; release to finish. On-device only.`
        }
        control={
          <Switch
            checked={settings.dictationEnabled}
            disabled={!available || saving}
            onCheckedChange={(checked) => void update({ dictationEnabled: checked })}
            aria-label={zh ? "按住说话" : "Push to talk"}
          />
        }
      />
      {settings.dictationEnabled ? (
        <SettingsRow
          label={zh ? "说话快捷键" : "Dictation shortcut"}
          description={
            message ? (
              <span className="text-[var(--leo-attention)]" role="status">
                {message}
              </span>
            ) : zh ? (
              "需要至少一个 ⌘ / ⌃ / ⌥。"
            ) : (
              "Requires at least one modifier (⌘ / ⌃ / ⌥)."
            )
          }
          control={
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-pressed={recording}
              disabled={!available || saving}
              onClick={() => setRecording((value) => !value)}
            >
              {recording ? (zh ? "按下新的组合键…" : "Press shortcut…") : currentShortcut}
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        label={zh ? "朗读回复" : "Read aloud"}
        description={
          zh
            ? "回复下方出现朗读按钮，用系统语音念出来（代码块跳过）。"
            : "Show a Read Aloud button on assistant replies using system speech (code blocks skipped)."
        }
        control={
          <Switch
            checked={settings.readAloudEnabled}
            disabled={!available || saving}
            onCheckedChange={(checked) => void update({ readAloudEnabled: checked })}
            aria-label={zh ? "朗读回复" : "Read aloud"}
          />
        }
      />
    </div>
  );
}
