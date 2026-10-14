import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsRow.js";
import type { LeoLinkBridge, LinkStatus } from "./LeoPhoneLinkSection.js";

export function DirectConnectionSettings({
  bridge,
  status,
  onPair,
  pending,
}: {
  bridge: LeoLinkBridge;
  status: LinkStatus | null;
  onPair: () => void;
  pending: boolean;
}) {
  const [baseURL, setBaseURL] = useState("");
  const [port, setPort] = useState("38474");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [treasuryEnabled, setTreasuryEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current && status?.direct?.baseURL) {
      setBaseURL(status.direct.baseURL);
      setPort(String(status.direct.port ?? 38474));
      setSyncEnabled(status.direct.syncEnabled);
      setTreasuryEnabled(status.direct.treasuryEnabled);
      initialized.current = true;
    }
  }, [status]);
  const save = async (enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await bridge.direct!("configure", {
        enabled,
        baseURL: baseURL.trim(),
        port: Number(port),
        syncEnabled,
        treasuryEnabled,
      });
      setMessage(
        result.ok ? "已保存，15 秒内应用。HTTPS 转发须在 Tailscale 中完成配置。" : result.error,
      );
    } catch {
      setMessage("保存失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (deviceId: string) => {
    setBusy(true);
    try {
      const result = await bridge.direct!("revoke", { deviceId });
      setMessage(result.ok ? "已撤销这台设备在本 Mac 的访问权限" : result.error);
    } catch {
      setMessage("撤销失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const devices = status?.direct?.devices ?? [];
  return (
    <>
      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">Tailscale 直连</div>
        <SettingsGroupCard>
          <SettingsRow
            label="Tailscale HTTPS 地址"
            description={
              status?.direct?.running
                ? "本机直连接口已启动；手机验证 HTTPS 和身份后优先使用。"
                : (status?.direct?.error ?? "直连尚未启用，现有中继连接继续工作。")
            }
            controlLayout="wide"
            control={
              <Input
                aria-label="Tailscale HTTPS 地址"
                type="url"
                placeholder="https://your-mac.your-tailnet.ts.net"
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
              />
            }
          />
          <SettingsRow
            label="专用本机端口"
            description={`在 Tailscale Serve 中将上面的 HTTPS 地址转发到 127.0.0.1:${port || "38474"}。不会自动修改现有 Serve 或 Funnel 配置。`}
            control={
              <Input
                aria-label="直连本机端口"
                type="number"
                min={1024}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
            }
          />
          <SettingsRow
            label="同步副本"
            description="允许已配对设备将同步副本保存到这台 Mac"
            control={
              <Switch
                aria-label="同步副本"
                checked={syncEnabled}
                onCheckedChange={setSyncEnabled}
              />
            }
          />
          <SettingsRow
            label="藏宝阁"
            description="允许已配对设备访问这台 Mac 的藏宝阁"
            control={
              <Switch
                aria-label="藏宝阁"
                checked={treasuryEnabled}
                onCheckedChange={setTreasuryEnabled}
              />
            }
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <Button
              type="button"
              size="lg"
              disabled={busy || !baseURL.trim()}
              onClick={() => void save(true)}
            >
              保存并启用
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={busy || !status?.direct?.running}
              onClick={() => void save(false)}
            >
              停用直连
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={busy || pending || !status?.direct?.running}
              onClick={onPair}
            >
              生成直连配对码
            </Button>
            <span className="text-ui-caption text-foreground-subtlest">
              开关和地址在保存后生效；直连和中继复用同一任务。
            </span>
          </div>
        </SettingsGroupCard>
        {message ? (
          <p role="status" className="text-ui-caption text-foreground-subtle">
            {message}
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">已授权设备</div>
        <SettingsGroupCard>
          {devices.length === 0 ? (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              还没有设备通过直连授权。
            </div>
          ) : (
            devices.map((device) => (
              <SettingsRow
                key={device.deviceId}
                label={<span className="break-all">{device.name}</span>}
                control={
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    className="text-destructive"
                    disabled={busy}
                    onClick={() => void revoke(device.deviceId)}
                    aria-label={`撤销 ${device.name} 的访问`}
                  >
                    撤销访问
                  </Button>
                }
              />
            ))
          )}
        </SettingsGroupCard>
      </section>
    </>
  );
}
