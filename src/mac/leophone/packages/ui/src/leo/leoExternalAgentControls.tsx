import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface AcpAgentListing {
  id: string;
  name: string;
  available: boolean;
  cliPath?: string;
  unavailableReason?: string;
  loginCommand?: string;
  /** Claude Code：已放了长期令牌（只有有无，界面拿不到内容）。 */
  longLivedToken?: boolean;
}

export interface AcpBridge {
  list(): Promise<AcpAgentListing[]>;
  login(agentId: string): Promise<{ ok: boolean }>;
  setClaudeToken?(token: string): Promise<{ ok: boolean; error?: string }>;
  proxy?(enabled?: boolean): Promise<{ enabled: boolean; proxy: string | null }>;
  loginFlow?(action: string, agentId: string, flowId?: string, code?: string): Promise<unknown>;
}

interface LoginFlowView {
  flow_id: string;
  status: "starting" | "waiting_for_user" | "verifying" | "succeeded" | "failed" | "cancelled";
  url?: string;
  user_code?: string;
  needs_code: boolean;
  code_kind?: "auth_code" | "api_key";
  message?: string;
}

/** [fix-remote] 网页登录（与手机同一套流程）：设备码 / 授权页在本机浏览器打开，凭据只写本机各 CLI 自己的位置。 */
export function WebLoginControl({ api, agentId, onDone }: { api: AcpBridge; agentId: string; onDone: () => void }) {
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const [flow, setFlow] = useState<LoginFlowView | null>(null);
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const active = Boolean(flow && !["succeeded", "failed", "cancelled"].includes(flow.status));
  const flowId = flow?.flow_id ?? null;
  useEffect(() => {
    if (!flowId || !active || !api.loginFlow) return;
    const myEpoch = epochRef.current;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.loginFlow!("get", agentId, flowId)
        .then((next) => {
          if (cancelled || !mountedRef.current || epochRef.current !== myEpoch) return;
          const view = next as LoginFlowView | null;
          if (!view) return;
          setFlow(view);
          if (view.status === "succeeded") onDoneRef.current();
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, agentId, flowId, active]);

  if (!api.loginFlow) return null;

  const start = async () => {
    if (starting) return;
    const myEpoch = ++epochRef.current;
    setStarting(true);
    try {
      const view = (await api.loginFlow!("start", agentId)) as LoginFlowView | null;
      if (!mountedRef.current || epochRef.current !== myEpoch) return;
      setFlow(view);
      setCode("");
    } catch {
      if (!mountedRef.current || epochRef.current !== myEpoch) return;
      setFlow({
        flow_id: "",
        status: "failed",
        needs_code: false,
        message: zh ? "启动登录失败，请稍后重试" : "Failed to start sign-in. Please retry.",
      });
    } finally {
      if (mountedRef.current && epochRef.current === myEpoch) setStarting(false);
    }
  };

  if (!flow || !active) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={starting} onClick={() => void start()}>
          {zh ? "网页登录" : "Sign in via browser"}
        </Button>
        {flow?.status === "succeeded" ? (
          <span className="text-ui-sm text-brand">{zh ? "已登录" : "Signed in"}</span>
        ) : null}
        {flow?.status === "failed" ? (
          <span role="alert" className="text-ui-sm text-destructive">
            {flow.message ?? (zh ? "登录失败" : "Sign-in failed")}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-1.5">
      {flow.url ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => void api.loginFlow!("open", agentId, flow.flow_id).catch(() => undefined)}>
            {flow.code_kind === "api_key"
              ? zh ? "打开获取 API key 的页面" : "Open API key page"
              : zh ? "在浏览器打开授权页" : "Open authorization page"}
          </Button>
          {flow.user_code ? (
            <span className="font-mono text-ui-base text-foreground" data-testid="leo-login-user-code">
              {flow.user_code}
            </span>
          ) : null}
        </div>
      ) : (
        <span className="text-ui-sm text-foreground-subtle">{zh ? "正在准备登录…" : "Preparing sign-in…"}</span>
      )}
      {flow.needs_code ? (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              flow.code_kind === "api_key"
                ? zh ? "粘贴 API key" : "Paste API key"
                : zh ? "粘贴网页给出的授权码" : "Paste authorization code"
            }
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-label={zh ? "登录授权码" : "Sign-in authorization code"}
          />
          <Button
            type="button"
            size="sm"
            disabled={!code.trim() || submitting || flow.status === "verifying"}
            onClick={() => {
              if (submitting) return;
              const myEpoch = epochRef.current;
              setSubmitting(true);
              void api.loginFlow!("code", agentId, flow.flow_id, code)
                .then((next) => {
                  if (!mountedRef.current || epochRef.current !== myEpoch) return;
                  setCode("");
                  if (next) setFlow(next as LoginFlowView);
                  if ((next as LoginFlowView | null)?.status === "succeeded") onDoneRef.current();
                })
                .catch(() => {
                  if (!mountedRef.current || epochRef.current !== myEpoch) return;
                  setFlow({
                    ...flow,
                    status: "failed",
                    message: zh ? "提交授权码失败，请重试" : "Failed to submit code. Please retry.",
                  });
                })
                .finally(() => {
                  if (mountedRef.current && epochRef.current === myEpoch) setSubmitting(false);
                });
            }}
          >
            {zh ? "提交" : "Submit"}
          </Button>
        </div>
      ) : (
        <span className="text-ui-sm text-foreground-subtle">
          {zh ? "在网页上确认上面的代码，完成后这里会自动更新。" : "Confirm the code in your browser; status updates automatically."}
        </span>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            epochRef.current += 1;
            setStarting(false);
            setSubmitting(false);
            const cancellingId = flow.flow_id;
            setFlow(null);
            void api.loginFlow!("cancel", agentId, cancellingId).catch(() => undefined);
          }}
        >
          {zh ? "取消" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}

/** [fix-remote] 「外部 agent 使用系统代理」（默认开）：按 macOS 系统代理设置代理变量，已有环境变量时不覆盖。 */
export function SystemProxyToggle({ api }: { api: AcpBridge }) {
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const [state, setState] = useState<{ enabled: boolean; proxy: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    void api.proxy?.()
      .then((next) => {
        if (mountedRef.current) setState(next);
      })
      .catch(() => {
        if (mountedRef.current) setState(null);
      });
    return () => {
      mountedRef.current = false;
    };
  }, [api]);
  if (!api.proxy || !state) return null;
  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-ui-base font-medium text-foreground">
          {zh ? "外部 agent 使用系统代理" : "Use system proxy for external agents"}
        </div>
        <div className="text-ui-sm text-foreground-subtle">
          {state.proxy
            ? zh
              ? `按系统代理（${state.proxy}）连外网；已在环境里设了代理时不覆盖。改动对新开的 agent 生效。`
              : `Routes external agents through the system proxy (${state.proxy}) without overriding existing env vars. Applies to newly started agents.`
            : zh
              ? "这台 Mac 没开系统代理，打开也不会改变什么。"
              : "No macOS system proxy is active right now; enabling has no effect until one is configured."}
        </div>
      </div>
      <Switch
        checked={state.enabled}
        disabled={saving}
        aria-label={zh ? "外部 agent 使用系统代理" : "Use system proxy for external agents"}
        onCheckedChange={(checked) => {
          if (saving) return;
          setSaving(true);
          void api.proxy!(checked)
            .then((next) => {
              if (mountedRef.current) setState(next);
            })
            .catch(() => undefined)
            .finally(() => {
              if (mountedRef.current) setSaving(false);
            });
        }}
      />
    </div>
  );
}

/** [fix-remote] Claude Code 长期令牌（`claude setup-token`）：只写不读，界面只显示配置状态。 */
export function ClaudeTokenControl({ api, configured, onSaved }: { api: AcpBridge; configured: boolean; onSaved: () => void }) {
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const save = async (token: string) => {
    if (saving || !api.setClaudeToken) return;
    setSaving(true);
    setError(null);
    const fallbackError = zh ? "保存失败" : "Failed to save";
    try {
      const result = await api.setClaudeToken(token).catch(() => ({ ok: false, error: fallbackError }));
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error ?? fallbackError);
        return;
      }
      setValue("");
      setError(null);
      setEditing(false);
      onSaved();
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  if (!api.setClaudeToken) return null;
  if (!editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {configured ? (
            <span className="text-ui-sm text-brand" data-testid="leo-claude-token-status">
              {zh ? "已使用长期令牌" : "Long-lived token configured"}
            </span>
          ) : null}
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => { setError(null); setEditing(true); }}>
            <KeyRound className="mr-1.5 size-3.5" aria-hidden="true" />
            {configured ? (zh ? "更换令牌" : "Replace token") : zh ? "粘贴令牌" : "Paste token"}
          </Button>
          {configured ? (
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => void save("")}>
              {zh ? "移除" : "Remove"}
            </Button>
          ) : null}
        </div>
        {error ? <span role="alert" className="text-ui-sm text-destructive">{error}</span> : null}
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={zh ? "粘贴 claude setup-token 生成的 sk-ant-oat01-…" : "Paste sk-ant-oat01-… from claude setup-token"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label={zh ? "Claude Code 长期令牌" : "Claude Code long-lived token"}
        />
        <Button type="button" size="sm" disabled={!value.trim() || saving} onClick={() => void save(value)}>
          {zh ? "保存" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => { setError(null); setEditing(false); }}>
          {zh ? "取消" : "Cancel"}
        </Button>
      </div>
      {error ? <span role="alert" className="text-ui-sm text-destructive">{error}</span> : null}
    </div>
  );
}
