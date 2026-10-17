import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsRow.js";

/**
 * [leo][WP-50/51/52] 设置 → 连接手机 → 屏幕:「允许手机查看屏幕」(默认关)、「只走 Tailscale」、
 * 「允许手机操控」(scope screen.control,默认关)+ 屏幕录制权限状态与去系统设置。契约见 docs/specs/leo-screen.md;
 * 没开查看开关一律 403 screen_disabled,没开操控开关时视频会话不给输入通道。
 */

interface ScreenState {
  enabled: boolean;
  tailnetOnly?: boolean;
  control?: boolean;
  accessibility?: boolean;
  hostError: string | null;
  permission: string;
}

interface ScreenBridge {
  screenStatus?: () => Promise<ScreenState>;
  setScreenEnabled?: (enabled: boolean) => Promise<ScreenState>;
  setScreenOptions?: (patch: { tailnet_only?: boolean; control?: boolean }) => Promise<ScreenState>;
  openScreenSettings?: () => Promise<boolean>;
  openAccessibilitySettings?: () => Promise<boolean>;
}

function screenBridge(): Required<ScreenBridge> | null {
  const bridge = (window as unknown as { leoLink?: ScreenBridge }).leoLink;
  return bridge?.screenStatus &&
    bridge.setScreenEnabled &&
    bridge.setScreenOptions &&
    bridge.openScreenSettings
    ? (bridge as Required<ScreenBridge>)
    : null;
}

export function LeoScreenShareSettings() {
  const bridge = screenBridge();
  const [state, setState] = useState<ScreenState | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    if (!bridge) return;
    void bridge
      .screenStatus()
      .then(setState)
      .catch((error: unknown) => logger.warn("[LeoScreenShareSettings] 读取失败", error));
  }, [bridge]);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  if (!bridge || !state) return null;
  const granted = state.permission === "granted";
  const save = (request: Promise<ScreenState>) => {
    setSaving(true);
    void request
      .then(setState)
      .catch((error: unknown) => logger.warn("[LeoScreenShareSettings] 保存失败", error))
      .finally(() => setSaving(false));
  };
  const locked = saving || Boolean(state.hostError);
  return (
    <section className="space-y-2" data-testid="leo-screen-share-settings">
      <h3 className="px-1 text-ui-sm font-medium text-foreground-subtle">屏幕</h3>
      <SettingsGroupCard>
        <SettingsRow
          label="允许手机查看屏幕"
          description={
            state.hostError
              ? `读不到开关状态（${state.hostError}）`
              : "已配对的 iPhone / iPad 可以看这台 Mac 的屏幕：视频直连（Tailscale / 局域网），或截图（经中继最多每秒一张）。默认只能看，不能操作。"
          }
          control={
            <Switch
              checked={state.enabled}
              disabled={locked}
              aria-label="允许手机查看屏幕"
              onCheckedChange={(checked) => save(bridge.setScreenEnabled(checked))}
            />
          }
        />
        <SettingsRow
          label="只走 Tailscale"
          description="视频看屏只用 Tailscale 地址直连，不走局域网、公网打洞和中转服务器。手机不在 Tailscale 上时会连不上。"
          control={
            <Switch
              checked={state.tailnetOnly === true}
              disabled={locked || !state.enabled}
              aria-label="只走 Tailscale"
              onCheckedChange={(checked) =>
                save(bridge.setScreenOptions({ tailnet_only: checked }))
              }
            />
          }
        />
        <SettingsRow
          label="允许手机操控"
          description="打开后，正在看屏的 iPhone / iPad 可以操作鼠标和键盘。被操控时菜单栏会出现红点「正在被控制」，在 Mac 上连按三次 Esc 立即断开。需要给 LeoBot 辅助功能权限。"
          control={
            <Switch
              checked={state.control === true}
              disabled={locked || !state.enabled}
              aria-label="允许手机操控"
              onCheckedChange={(checked) => save(bridge.setScreenOptions({ control: checked }))}
            />
          }
        />
        {state.control && !state.accessibility ? (
          <SettingsRow
            label="辅助功能权限"
            description="macOS 需要允许 LeoBot 使用辅助功能，手机的鼠标键盘操作和「连按三次 Esc 断开」才会生效。"
            control={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void bridge.openAccessibilitySettings?.()}
              >
                去系统设置
                <ExternalLink className="ml-1.5 size-3.5" />
              </Button>
            }
          />
        ) : null}
        <SettingsRow
          label="屏幕录制权限"
          description={
            granted
              ? "LeoBot 已获得屏幕录制权限。"
              : "macOS 需要允许 LeoBot 录制屏幕，手机才看得到画面；没允许时手机会收到提示。"
          }
          control={
            granted ? (
              <span className="text-ui-sm text-foreground-subtle">已允许</span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void bridge.openScreenSettings()}
              >
                去系统设置
                <ExternalLink className="ml-1.5 size-3.5" />
              </Button>
            )
          }
        />
      </SettingsGroupCard>
    </section>
  );
}
