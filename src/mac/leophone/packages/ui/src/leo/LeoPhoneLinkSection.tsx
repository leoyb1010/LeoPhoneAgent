import { DirectConnectionSettings } from "./DirectConnectionSettings.js";
import { useEffect, useRef, useState } from "react";
import { createPhonePairingSession, type VisiblePairingCode } from "./phonePairingSession.js";
import QRCode from "qrcode";
import { RefreshCw, Smartphone } from "lucide-react";

import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";

/**
 * [leo-link] 远程控制弹层里的「LeoPhoneAgent 手机 App」:这台 Mac 的连接状态 + 扫码加手机。
 *
 * 以前加手机要在终端 `cat ~/.leoagent/key` 再粘到手机里,全家一把钥匙,丢了全断。
 * 现在点一下出一个一次性码,手机「远程机器 → 扫码添加机器」扫了就领到自己的钥匙。
 * 码是凭据:只在点按钮时才向中继要,5 分钟过期、只能用一次,关掉弹层就丢弃。
 */
export type LinkStatus = {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  connected: boolean;
  /** 中继能不能出配对码;老中继(2026-08 之前)没有这个接口。 */
  pairing?: "supported" | "unsupported" | "unknown";
  machine: string;
  relayHost: string | null;
  relayVersion: string | null;
  lastError: string | null;
  direct?: {
    running: boolean;
    deviceId: string | null;
    baseURL: string | null;
    port: number | null;
    error: string | null;
    syncEnabled: boolean;
    treasuryEnabled: boolean;
    devices: { deviceId: string; name: string; expiresAt: number }[];
  };
};

type PairingCode = { payload: string; machine: string; exp: number };

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type LeoLinkBridge = {
  status(): Promise<IpcResult<LinkStatus>>;
  pair(): Promise<IpcResult<PairingCode>>;
  direct?(action: "pair" | "configure" | "revoke", body?: unknown): Promise<IpcResult<PairingCode>>;
  revoke?(payload: string): Promise<IpcResult<unknown>>;
};

const FOCUS_RING =
  "focus-visible:outline-2! focus-visible:outline-offset-2! focus-visible:outline-brand!";

function getLeoLinkBridge(): LeoLinkBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { leoLink?: LeoLinkBridge }).leoLink ?? null;
}

const STATUS_POLL_MS = 5_000;

export function LeoPhoneLinkSection({ className }: { className?: string }) {
  const bridge = getLeoLinkBridge();
  if (!bridge) return null;
  return <LeoPhoneLinkSectionBody bridge={bridge} className={className} />;
}

function LeoPhoneLinkSectionBody({
  bridge,
  className,
}: {
  bridge: LeoLinkBridge;
  className?: string;
}) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [code, setCode] = useState<VisiblePairingCode | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    let loading = false;
    const load = async () => {
      // IPC 可以拒绝或超过轮询周期；串行读取避免旧响应覆盖新状态。
      if (loading) return;
      loading = true;
      try {
        const result = await bridge.status();
        if (!alive) return;
        if (result.ok) {
          setStatus(result.data);
          setStatusError(null);
        } else {
          setStatusError(result.error);
        }
      } catch {
        if (alive) setStatusError("连接状态读取失败，正在重试");
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(load, STATUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bridge]);

  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [code]);

  const pairingSession = useRef<ReturnType<typeof createPhonePairingSession> | null>(null);
  useEffect(() => {
    const session = createPhonePairingSession({
      issue: (direct) => (direct && bridge.direct ? bridge.direct("pair") : bridge.pair()),
      revoke: bridge.revoke ? (payload) => bridge.revoke!(payload) : undefined,
      render: (payload) =>
        QRCode.toDataURL(payload, {
          margin: 1,
          width: 360,
          errorCorrectionLevel: "M",
          color: { dark: "#101413", light: "#ffffff" },
        }),
      onCode: (value) => {
        setNow(Date.now());
        setCode(value);
      },
      onPending: setPending,
      onError: setError,
      // 不打印 payload 或错误对象，避免把一次性凭据写入诊断。
      onCleanupError: () => logger.warn("[leo/link] 配对码清理失败，原码可能有效至到期"),
    });
    pairingSession.current = session;
    return () => {
      session.dispose();
      if (pairingSession.current === session) pairingSession.current = null;
    };
  }, [bridge]);
  const generate = (direct = false) => pairingSession.current?.generate(direct);

  const remaining = code ? Math.max(0, Math.round(code.exp - now / 1000)) : 0;
  const expired = code !== null && remaining === 0;
  const ready = Boolean(!statusError && status?.running && status.connected);
  const relayTooOld = ready && status?.pairing === "unsupported";
  const statusLine = statusError ? `读不到连接状态（${statusError}）` : describeStatus(status);

  return (
    <section className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex items-start gap-2">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-ui-base font-medium text-foreground">LeoBot 手机 App</div>
          <p className="flex items-center gap-1.5 text-ui-caption text-foreground-subtle">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                ready
                  ? "bg-brand"
                  : status
                    ? "bg-[var(--leo-attention,#d08a2e)]"
                    : "bg-foreground-subtlest",
              )}
            />
            <span className="truncate">{statusLine}</span>
          </p>
        </div>
      </div>

      {code && !expired ? (
        <div className="mt-4 flex items-center gap-4">
          <img
            src={code.image}
            alt="配对二维码"
            draggable={false}
            className="size-36 shrink-0 rounded-lg bg-white p-1.5"
          />
          <div className="min-w-0 space-y-2 text-ui-caption text-foreground-subtle">
            <p className="text-ui-base text-foreground">用手机扫这个码</p>
            <p>
              手机上打开 LeoBot → 设置 → 远程机器 → 扫码添加机器。每台手机领到自己的钥匙，
              丢了一台不影响其他。
            </p>
            <p className="tabular-nums">{formatRemaining(remaining)} 后失效 · 只能用一次</p>
            <button
              type="button"
              onClick={() => void generate(code.direct)}
              disabled={pending}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50",
                FOCUS_RING,
              )}
            >
              <RefreshCw className={cn("size-3", pending && "motion-safe:animate-spin")} />
              换一个码
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={!ready || relayTooOld || pending}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-ui-base font-medium text-foreground-inverse transition-[filter,opacity] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40",
              FOCUS_RING,
            )}
          >
            {pending ? <RefreshCw className="size-3.5 motion-safe:animate-spin" /> : null}
            {relayTooOld ? "中继待升级" : expired ? "码已过期，再生成一个" : "扫码连接手机"}
          </button>
          <span className="text-ui-caption text-foreground-subtlest">
            {relayTooOld
              ? "连着的中继还是旧版，升级到 0.2 后才能扫码加手机"
              : (setupHint(status) ?? "不用再把钥匙抄到手机上")}
          </span>
        </div>
      )}

      {bridge.direct ? (
        <DirectConnectionSettings
          bridge={bridge}
          status={status}
          onPair={() => void generate(true)}
          pending={pending}
        />
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-ui-caption text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function describeStatus(status: LinkStatus | null): string {
  if (!status) return "正在读取连接状态…";
  if (!status.configured && status.direct?.running) return `${status.machine} 直连接口已启动`;
  if (!status.configured) return "这台 Mac 还没配置中继";
  if (!status.enabled) return "手机连接未开启";
  if (!status.running) return "手机连接正在启动…";
  if (status.connected) {
    const version = status.relayVersion ? ` · 中继 ${status.relayVersion}` : "";
    return `${status.machine} 已连上中继${version}`;
  }
  return status.lastError ? `正在重连中继（${status.lastError}）` : "正在连接中继…";
}

/** 连接面板不能是死胡同:没配好时告诉用户下一步在哪做。 */
function setupHint(status: LinkStatus | null): string | null {
  if (!status) return null;
  if (!status.configured)
    return '在 ~/.leoagent/relay.json 写入中继地址和钥匙（{"url","key"}），保存后 15 秒内自动连上';
  if (!status.enabled)
    return "运行 src/mac/leophone/scripts/leo-link-switch.sh 打开手机连接，不用重启 App";
  return null;
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
