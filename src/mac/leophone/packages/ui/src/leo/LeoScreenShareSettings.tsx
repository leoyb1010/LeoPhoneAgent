import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
  /** 注入助手 leo-input 在不在；缺了不能打开操控。 */
  inputHelper?: boolean;
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
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const [state, setState] = useState<ScreenState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!bridge) return;
    const epoch = ++epochRef.current;
    void bridge
      .screenStatus()
      .then((next) => {
        if (!mountedRef.current || epochRef.current !== epoch) return;
        setState(next);
        setSaveError(null);
      })
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
    const epoch = ++epochRef.current;
    setSaving(true);
    setSaveError(null);
    void request
      .then((next) => {
        if (!mountedRef.current || epochRef.current !== epoch) return;
        setState(next);
      })
      .catch((error: unknown) => {
        logger.warn("[LeoScreenShareSettings] 保存失败", error);
        if (!mountedRef.current || epochRef.current !== epoch) return;
        setSaveError(zh ? "保存屏幕共享设置失败，请重试" : "Failed to save screen sharing setting. Try again.");
      })
      .finally(() => {
        if (mountedRef.current && epochRef.current === epoch) setSaving(false);
      });
  };
  const locked = saving || Boolean(state.hostError);
  const helperMissing = state.inputHelper === false;
  return (
    <section className="space-y-2" data-testid="leo-screen-share-settings">
      <h3 className="px-1 text-ui-sm font-medium text-foreground-subtle">
        {zh ? "屏幕" : "Screen"}
      </h3>
      <SettingsGroupCard>
        {saveError ? (
          <div role="alert" className="border-b border-border px-4 py-2.5 text-ui-sm text-destructive">
            {saveError}
          </div>
        ) : null}
        <SettingsRow
          label={zh ? "允许手机查看屏幕" : "Allow phone screen viewing"}
          description={
            state.hostError
              ? zh
                ? `读不到开关状态（${state.hostError}）`
                : `Could not read switch state (${state.hostError})`
              : zh
                ? "已配对的 iPhone / iPad 可以看这台 Mac 的屏幕：视频直连（Tailscale / 局域网），或截图（经中继最多每秒一张）。默认只能看，不能操作。"
                : "Paired iPhone / iPad devices can view this Mac's screen via direct video (Tailscale / LAN) or relay snapshots (up to 1 fps). View-only by default."
          }
          control={
            <div className="flex items-center gap-2">
              {state.hostError ? (
                <Button type="button" size="sm" variant="outline" onClick={refresh}>
                  {zh ? "重试" : "Retry"}
                </Button>
              ) : null}
              <Switch
                checked={state.enabled}
                disabled={locked}
                aria-label={zh ? "允许手机查看屏幕" : "Allow phone screen viewing"}
                onCheckedChange={(checked) => save(bridge.setScreenEnabled(checked))}
              />
            </div>
          }
        />
        <SettingsRow
          label={zh ? "只走 Tailscale" : "Tailscale only"}
          description={
            zh
              ? "视频看屏只用 Tailscale 地址直连，不走局域网、公网打洞和中转服务器。手机不在 Tailscale 上时会连不上。"
              : "Stream live video only over Tailscale direct addresses, disabling LAN, NAT traversal, and relay fallback."
          }
          control={
            <Switch
              checked={state.tailnetOnly === true}
              disabled={locked || !state.enabled}
              aria-label={zh ? "只走 Tailscale" : "Tailscale only"}
              onCheckedChange={(checked) =>
                save(bridge.setScreenOptions({ tailnet_only: checked }))
              }
            />
          }
        />
        <SettingsRow
          label={zh ? "允许手机操控" : "Allow remote control"}
          description={
            helperMissing
              ? zh
                ? "这台 Mac 上缺少操控助手（leo-input），暂时不能打开操控。重新安装 LeoBot 即可恢复。"
                : "Remote input helper (leo-input) is missing on this Mac. Reinstall LeoBot to restore control."
              : zh
                ? "打开后，正在看屏的 iPhone / iPad 可以操作鼠标和键盘。被操控时菜单栏会出现红点「正在被控制」，在 Mac 上连按三次 Esc 立即断开（断开后 10 秒内不能再操控）。需要给 LeoBot 辅助功能权限。"
                : "Allow viewing devices to send mouse and keyboard input. Press Esc three times on Mac to disconnect immediately (10s cooldown). Requires Accessibility permission."
          }
          control={
            <Switch
              checked={state.control === true}
              disabled={locked || !state.enabled || (helperMissing && state.control !== true)}
              aria-label={zh ? "允许手机操控" : "Allow remote control"}
              onCheckedChange={(checked) => save(bridge.setScreenOptions({ control: checked }))}
            />
          }
        />
        {state.control && !state.accessibility ? (
          <SettingsRow
            label={zh ? "辅助功能权限" : "Accessibility permission"}
            description={
              zh
                ? "macOS 需要允许 LeoBot 使用辅助功能，手机的鼠标键盘操作和「连按三次 Esc 断开」才会生效。"
                : "Grant LeoBot Accessibility access in System Settings so remote input and triple-Esc disconnect work."
            }
            control={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void bridge.openAccessibilitySettings?.().catch((error: unknown) => {
                    logger.warn("[LeoScreenShareSettings] 打开辅助功能设置失败", error);
                  })
                }
              >
                {zh ? "去系统设置" : "Open Settings"}
                <ExternalLink className="ml-1.5 size-3.5" aria-hidden="true" />
              </Button>
            }
          />
        ) : null}
        <SettingsRow
          label={zh ? "屏幕录制权限" : "Screen Recording permission"}
          description={
            granted
              ? zh
                ? "LeoBot 已获得屏幕录制权限。"
                : "LeoBot has Screen Recording permission."
              : zh
                ? "macOS 需要允许 LeoBot 录制屏幕，手机才看得到画面；没允许时手机会收到提示。"
                : "Grant LeoBot Screen Recording access in System Settings so your phone can view this screen."
          }
          control={
            granted ? (
              <span className="text-ui-sm text-foreground-subtle">{zh ? "已允许" : "Granted"}</span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void bridge.openScreenSettings().catch((error: unknown) => {
                    logger.warn("[LeoScreenShareSettings] 打开录屏设置失败", error);
                  })
                }
              >
                {zh ? "去系统设置" : "Open Settings"}
                <ExternalLink className="ml-1.5 size-3.5" aria-hidden="true" />
              </Button>
            )
          }
        />
      </SettingsGroupCard>
    </section>
  );
}
