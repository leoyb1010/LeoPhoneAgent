import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsRow.js";

/**
 * [leo][WP-50] 设置 → 连接手机 → 屏幕:「允许手机查看屏幕」开关(默认关)+ 屏幕录制权限状态与去系统设置。
 * 手机经直连或中继拉 /screen/snapshot(docs/specs/leo-screen.md);没开这个开关一律 403 screen_disabled。
 */

interface ScreenState {
  enabled: boolean;
  hostError: string | null;
  permission: string;
}

interface ScreenBridge {
  screenStatus?: () => Promise<ScreenState>;
  setScreenEnabled?: (enabled: boolean) => Promise<ScreenState>;
  openScreenSettings?: () => Promise<boolean>;
}

function screenBridge(): Required<ScreenBridge> | null {
  const bridge = (window as unknown as { leoLink?: ScreenBridge }).leoLink;
  return bridge?.screenStatus && bridge.setScreenEnabled && bridge.openScreenSettings
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
  return (
    <section className="space-y-2" data-testid="leo-screen-share-settings">
      <h3 className="px-1 text-ui-sm font-medium text-foreground-subtle">屏幕</h3>
      <SettingsGroupCard>
        <SettingsRow
          label="允许手机查看屏幕"
          description={
            state.hostError
              ? `读不到开关状态（${state.hostError}）`
              : "已配对的 iPhone / iPad 可以看这台 Mac 的屏幕截图（直连约每 1.5 秒一张，经中继最多每秒一张）。只能看，不能操作。"
          }
          control={
            <Switch
              checked={state.enabled}
              disabled={saving || Boolean(state.hostError)}
              aria-label="允许手机查看屏幕"
              onCheckedChange={(checked) => {
                setSaving(true);
                void bridge
                  .setScreenEnabled(checked)
                  .then(setState)
                  .catch((error: unknown) =>
                    logger.warn("[LeoScreenShareSettings] 保存失败", error),
                  )
                  .finally(() => setSaving(false));
              }}
            />
          }
        />
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
