import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsRow.js";
import { setShortcutRecordingActive } from "@/shortcuts/bindings.js";

import { acceleratorFromKeyEvent, formatAccelerator } from "./quickEntryAccelerator.js";

/**
 * [leo] 设置 → 快捷键 顶部的「菜单栏与快速派发」(仅 macOS 桌面端,见 docs/specs/leo-quick-entry.md)。
 * 状态由主进程持有(userData/leo-quick-entry.json),这里只读写;改键先由主进程试注册,注册不上就保留原键位。
 */

interface QuickEntrySettings {
  menuBarEnabled: boolean;
  quickPanelEnabled: boolean;
  accelerator: string;
}

interface QuickSettingsResult {
  settings?: QuickEntrySettings;
  shortcutError?: string | null;
  error?: string;
}

interface LeoQuickBridge {
  getSettings(): Promise<QuickSettingsResult>;
  setSettings(patch: Partial<QuickEntrySettings>): Promise<QuickSettingsResult>;
}

/** 默认 ⌥Space;被输入法或别的 App 占用时推荐 ⌃⌥L。主进程会再校验(quickPanelCore.ts)。 */
const PRESETS = ["Alt+Space", "Control+Alt+L"] as const;

function quickBridge(): LeoQuickBridge | null {
  return (window as unknown as { leoQuick?: LeoQuickBridge }).leoQuick ?? null;
}

export function LeoQuickEntrySettings() {
  const bridge = quickBridge();
  if (!bridge) return null;
  return <LeoQuickEntrySettingsBody bridge={bridge} />;
}

function LeoQuickEntrySettingsBody({ bridge }: { bridge: LeoQuickBridge }) {
  const [settings, setSettings] = useState<QuickEntrySettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);

  const accept = useCallback((result: QuickSettingsResult) => {
    if (result.settings) setSettings(result.settings);
    setMessage(result.error ?? result.shortcutError ?? null);
  }, []);

  useEffect(() => {
    let alive = true;
    bridge
      .getSettings()
      .then((result) => {
        if (alive) accept(result);
      })
      .catch((error: unknown) => logger.warn("[LeoQuickEntrySettings] 读取设置失败", error));
    return () => {
      alive = false;
    };
  }, [accept, bridge]);

  const update = useCallback(
    async (patch: Partial<QuickEntrySettings>) => {
      setSaving(true);
      try {
        accept(await bridge.setSettings(patch));
      } catch (error) {
        logger.warn("[LeoQuickEntrySettings] 保存设置失败", error);
        setMessage("保存失败，请查看日志");
      } finally {
        setSaving(false);
      }
    },
    [accept, bridge],
  );

  useEffect(() => {
    if (!recording) return;
    // 录制期间暂停应用内快捷键分发,不然按下的组合会先触发应用命令。
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

  if (!settings) return null;
  const current = formatAccelerator(settings.accelerator);

  return (
    <div className="overflow-hidden rounded-xl border border-border" data-testid="leo-quick-entry-settings">
      <SettingsRow
        label="菜单栏图标"
        description="在屏幕顶部菜单栏显示 LeoBot：看在跑的任务、等你确认的审批，点一下就打开对应任务。"
        control={
          <Switch
            checked={settings.menuBarEnabled}
            disabled={saving}
            onCheckedChange={(checked) => void update({ menuBarEnabled: checked })}
            aria-label="菜单栏图标"
          />
        }
      />
      <SettingsRow
        label="快速派发"
        description={`在任何 App 里按 ${current} 呼出输入框，选好工作区回车就派一个新任务；⌘↩\uFE0E 派发并打开。`}
        control={
          <Switch
            checked={settings.quickPanelEnabled}
            disabled={saving}
            onCheckedChange={(checked) => void update({ quickPanelEnabled: checked })}
            aria-label="快速派发"
          />
        }
      />
      {settings.quickPanelEnabled ? (
        <SettingsRow
          label="快速派发快捷键"
          description={
            message ? (
              <span className="text-[var(--leo-attention)]" role="status">
                {message}
              </span>
            ) : (
              "需要至少一个 ⌘ / ⌃ / ⌥；被系统或别的 App 占用时会保留原来的键位。"
            )
          }
          controlLayout="wide"
          control={
            <div className="flex items-center gap-2">
              {PRESETS.filter((preset) => preset !== settings.accelerator).map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving || recording}
                  onClick={() => void update({ accelerator: preset })}
                >
                  用 {formatAccelerator(preset)}
                </Button>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                aria-pressed={recording}
                onClick={() => setRecording((value) => !value)}
                data-testid="leo-quick-entry-record"
              >
                {recording ? "按下新的组合键…" : current}
              </Button>
            </div>
          }
        />
      ) : null}
    </div>
  );
}
