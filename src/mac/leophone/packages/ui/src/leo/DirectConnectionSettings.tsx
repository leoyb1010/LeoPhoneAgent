import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import type { LeoLinkBridge, LinkStatus } from "./LeoPhoneLinkSection.js";
const FOCUS_RING =
  "focus-visible:outline-2! focus-visible:outline-offset-2! focus-visible:outline-brand!";

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
  const inputStyle = cn(
    "w-full rounded-md border border-border bg-background px-2 py-1.5 text-ui-base",
    FOCUS_RING,
  );
  return (
    <details className="mt-4 border-t border-border pt-3">
      <summary className={cn("cursor-pointer text-ui-base text-foreground", FOCUS_RING)}>
        Tailscale 直连与已授权设备
      </summary>
      <div className="mt-3 space-y-3 text-ui-caption text-foreground-subtle">
        <p>
          {status?.direct?.running
            ? "本机直连接口已启动；手机验证 HTTPS 和身份后优先使用。"
            : (status?.direct?.error ?? "直连尚未启用，现有中继连接继续工作。")}
        </p>
        <label className="block space-y-1">
          <span>这台 Mac 的 Tailscale HTTPS 地址</span>
          <input
            aria-label="Tailscale HTTPS 地址"
            type="url"
            placeholder="https://your-mac.your-tailnet.ts.net"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            className={inputStyle}
          />
        </label>
        <label className="block space-y-1">
          <span>专用本机端口</span>
          <input
            aria-label="直连本机端口"
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(event) => setPort(event.target.value)}
            className={inputStyle}
          />
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={syncEnabled}
            onChange={(event) => setSyncEnabled(event.target.checked)}
            className={FOCUS_RING}
          />
          <span>允许已配对设备将同步副本保存到这台 Mac</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={treasuryEnabled}
            onChange={(event) => setTreasuryEnabled(event.target.checked)}
            className={FOCUS_RING}
          />
          <span>允许已配对设备访问这台 Mac 的藏宝阁</span>
        </label>
        <p>
          在 Tailscale Serve 中将以上 HTTPS 地址转发到 127.0.0.1:{port || "38474"}。不会自动修改现有
          Serve 或 Funnel 配置。直连和中继复用同一任务。
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !baseURL.trim()}
            onClick={() => void save(true)}
            className={cn(
              "rounded-md border border-border px-2 py-1 text-foreground disabled:opacity-40",
              FOCUS_RING,
            )}
          >
            保存并启用
          </button>
          <button
            type="button"
            disabled={busy || !status?.direct?.running}
            onClick={() => void save(false)}
            className={cn(
              "rounded-md border border-border px-2 py-1 text-foreground disabled:opacity-40",
              FOCUS_RING,
            )}
          >
            停用直连
          </button>
          <button
            type="button"
            disabled={busy || pending || !status?.direct?.running}
            onClick={onPair}
            className={cn(
              "rounded-md border border-border px-2 py-1 text-foreground disabled:opacity-40",
              FOCUS_RING,
            )}
          >
            生成直连配对码
          </button>
        </div>
        {status?.direct?.devices.map((device) => (
          <div key={device.deviceId} className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-all">{device.name}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void revoke(device.deviceId)}
              aria-label={`撤销 ${device.name} 的访问`}
              className={cn(
                "shrink-0 rounded px-2 py-1 text-destructive disabled:opacity-40",
                FOCUS_RING,
              )}
            >
              撤销访问
            </button>
          </div>
        ))}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </details>
  );
}
