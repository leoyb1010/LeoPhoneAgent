import { useState } from "react";
import {
  paperclipLabel,
  type PaperclipPersistence,
  type PaperclipTransport,
} from "@zcode/services/paperclip";
import { usePaperclipWorkspace } from "../hooks/usePaperclipWorkspace.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { PaperclipWorkspaceHelp } from "./PaperclipWorkspaceHelp.js";
import { PaperclipReceiptBanner } from "./PaperclipReceiptBanner.js";
import { PaperclipTaskDetail } from "./PaperclipTaskDetail.js";

export interface PaperclipWorkspaceProps {
  transport: PaperclipTransport;
  persistence: PaperclipPersistence;
  onRecovery: () => void;
}
const connectionLabels = {
  unconfigured: "尚未配置",
  "signed-out": "请登录",
  connecting: "正在连接",
  online: "已连接",
  offline: "连接中断",
};
const selectClass = "w-full rounded-lg border border-input-border bg-input px-2 py-1 text-ui-base";
export function PaperclipWorkspace({
  transport,
  persistence,
  onRecovery,
}: PaperclipWorkspaceProps) {
  const { snapshot: state, service } = usePaperclipWorkspace(transport, persistence);
  const [settings, setSettings] = useState(false);
  const [serverUrl, setServerUrl] = useState(state.profile?.serverUrl ?? "");
  const [name, setName] = useState(state.profile?.name ?? "我的服务器");
  const [help, setHelp] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState("");
  const [query, setQuery] = useState("");
  const locked = state.busy || !!state.receipt || state.connection !== "online";
  const availableAgents = state.agents.filter((agent) =>
    ["active", "idle", "running"].includes(agent.status),
  );
  const bindingKey = state.binding
    ? `${state.binding.serverUrl}/${state.binding.companyId}/${state.binding.userId}`
    : "";
  const filtered = state.issues.filter((issue) =>
    `${issue.title} ${issue.identifier ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <main
      className="relative flex h-dvh min-h-0 flex-col bg-background text-ui-base text-foreground"
      data-testid="paperclip-workspace"
    >
      <div
        className="h-8 shrink-0 border-b border-border bg-header [-webkit-app-region:drag]"
        aria-hidden="true"
      />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-header px-4 py-3">
        <div>
          <h1 className="text-ui-lg font-medium">Leo · Paperclip 工作区</h1>
          <p className="text-ui-sm text-foreground-subtle">
            {state.profile?.name || "连接你的任务服务器"} · {connectionLabels[state.connection]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {state.profile && (
            <Button variant="outline" disabled={state.busy} onClick={() => void service.refresh()}>
              刷新连接
            </Button>
          )}
          {state.profile && state.user && state.connection === "signed-out" && (
            <Button disabled={state.busy} onClick={() => void service.signIn()}>
              重新登录
            </Button>
          )}
          <Button variant="ghost" onClick={() => setSettings(!settings)}>
            服务器设置
          </Button>
          <Button variant="ghost" onClick={() => setHelp(!help)}>
            使用帮助
          </Button>
          <Button variant="ghost" disabled={state.busy} onClick={() => setRecovery(true)}>
            本地恢复模式
          </Button>
        </div>
      </header>
      {state.error && (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-destructive"
        >
          {state.error}
        </div>
      )}
      {state.notice && (
        <div role="status" className="border-b border-border bg-surface px-4 py-2">
          {state.notice}
        </div>
      )}
      {state.receipt && (
        <PaperclipReceiptBanner
          receipt={state.receipt}
          busy={state.busy}
          onReconcile={() => void service.reconcile()}
          onAcknowledge={() => service.acknowledgeReceipt()}
        />
      )}
      {(settings || !state.profile) && (
        <section className="overflow-auto border-b border-border p-4" aria-label="服务器配置">
          <form
            className="mx-auto max-w-2xl space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void service.configure({ serverUrl, name }).then((ok) => {
                if (ok) setSettings(false);
              });
            }}
          >
            <h2 className="text-ui-lg font-medium">连接 Paperclip 服务器</h2>
            <p className="text-foreground-subtle">
              任务和执行者由服务器管理。首次使用请先部署服务器、创建公司并配置服务器上的 CLI 执行者
            </p>
            <label className="block space-y-1">
              服务器名称
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="我的服务器"
                maxLength={80}
              />
            </label>
            <label className="block space-y-1">
              服务器地址
              <Input
                type="url"
                required
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://paperclip.example.com"
                autoComplete="url"
              />
            </label>
            <p className="text-ui-sm text-foreground-subtle">
              使用 HTTPS 地址，不要填写 /api 路径、密码或 Agent 密钥。本机调试可使用
              http://localhost:3100
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={state.busy}>
                保存并连接
              </Button>
              {state.profile && (
                <Button variant="outline" type="button" onClick={() => setSettings(false)}>
                  关闭设置
                </Button>
              )}
            </div>
          </form>
        </section>
      )}
      <PaperclipWorkspaceHelp
        help={help}
        recovery={recovery}
        hasReceipt={!!state.receipt}
        closeHelp={() => setHelp(false)}
        closeRecovery={() => setRecovery(false)}
        onRecovery={onRecovery}
      />
      {state.profile && !state.user && (
        <section
          className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
          aria-label="登录服务器"
        >
          <h2 className="text-ui-xl font-medium">登录你的 Paperclip 账号</h2>
          <p className="max-w-lg text-foreground-subtle">
            将在独立的服务器登录窗口中验证身份。密码和会话凭据不会进入任务界面
          </p>
          <p className="break-all font-mono text-ui-sm">{state.profile.serverUrl}</p>
          <Button disabled={state.busy} onClick={() => void service.signIn()}>
            {state.busy ? "等待登录…" : "登录服务器"}
          </Button>
        </section>
      )}
      {state.user && (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside
            className="flex max-h-64 w-full shrink-0 flex-col border-b border-border bg-sidebar md:max-h-none md:w-72 md:border-r md:border-b-0"
            aria-label="任务列表"
          >
            <div className="space-y-3 border-b border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{state.user.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={state.busy}
                  onClick={() => void service.signOut()}
                >
                  退出登录
                </Button>
              </div>
              <label className="block space-y-1">
                <span className="text-ui-sm">工作公司</span>
                <select
                  value={state.binding?.companyId || ""}
                  disabled={state.busy}
                  className={selectClass}
                  onChange={(e) => {
                    setCreating(false);
                    setAgentId("");
                    void service.selectCompany(e.target.value);
                  }}
                >
                  <option value="" disabled>
                    请选择公司
                  </option>
                  {state.companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>
              {state.companies.length === 0 && (
                <p className="text-ui-sm text-foreground-subtle">
                  还没有可访问的公司，请联系服务器管理员
                </p>
              )}
              <Button
                className="w-full"
                disabled={!state.binding || locked}
                onClick={() => {
                  setCreating(true);
                  setTitle("");
                  setDescription("");
                  setAgentId(availableAgents[0]?.id || "");
                }}
              >
                新建任务
              </Button>
              <Input
                aria-label="筛选任务"
                placeholder="筛选最近任务…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {state.binding && !filtered.length && (
                <p className="p-3 text-foreground-subtle">
                  {query ? "没有匹配的任务" : "暂无任务。创建第一项服务器任务吧"}
                </p>
              )}
              {filtered.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  className={`mb-1 w-full rounded-lg p-3 text-left hover:bg-hover focus-visible:outline focus-visible:outline-2 ${state.detail?.issue.id === issue.id ? "bg-selected" : ""}`}
                  onClick={() => {
                    setCreating(false);
                    void service.selectIssue(issue.id);
                  }}
                >
                  <div className="break-words font-medium">{issue.title}</div>
                  <div className="mt-1 text-ui-sm text-foreground-subtle">
                    {issue.identifier} · {paperclipLabel(issue.status)}
                  </div>
                </button>
              ))}
            </div>
            {state.updatedAt && (
              <p className="border-t border-border p-3 text-ui-xs text-foreground-subtle">
                上次同步：{new Date(state.updatedAt).toLocaleTimeString("zh-CN")}
              </p>
            )}
          </aside>
          {creating ? (
            <section className="min-h-0 flex-1 overflow-auto p-6" aria-label="新建服务器任务">
              <form
                className="mx-auto max-w-2xl space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void service
                    .mutate({
                      kind: "create",
                      title: title.trim(),
                      description: description.trim(),
                      agentId,
                    })
                    .then((ok) => {
                      if (ok) setCreating(false);
                    });
                }}
              >
                <h2 className="text-ui-lg font-medium">新建服务器任务</h2>
                <label className="block space-y-1">
                  任务标题
                  <Input
                    required
                    maxLength={240}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={locked}
                    placeholder="希望执行者完成什么？"
                  />
                </label>
                <label className="block space-y-1">
                  任务说明
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={locked}
                    maxLength={100000}
                    placeholder="目标、背景、限制和验收标准…"
                  />
                </label>
                <label className="block space-y-1">
                  服务器执行者
                  <select
                    required
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    className={selectClass}
                    disabled={locked}
                  >
                    <option value="" disabled>
                      请选择执行者
                    </option>
                    {availableAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} · {paperclipLabel(agent.status)}
                      </option>
                    ))}
                  </select>
                </label>
                {!availableAgents.length && (
                  <p className="text-warning">
                    当前公司没有可用的执行者。请在服务器配置并启用 CLI 执行者后刷新
                  </p>
                )}
                <div className="flex gap-2">
                  <Button type="submit" disabled={locked || !title.trim() || !agentId}>
                    {state.busy ? "提交中…" : "创建并交给服务器"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={state.busy}
                    onClick={() => setCreating(false)}
                  >
                    取消
                  </Button>
                </div>
              </form>
            </section>
          ) : state.detail ? (
            <PaperclipTaskDetail
              key={`${bindingKey}/${state.detail.issue.id}`}
              detail={state.detail}
              disabled={locked}
              log={state.log}
              onCommand={(command) => service.mutate(command)}
              onLog={(id) => void service.loadLog(id)}
              onDownload={(id) => void service.download(id)}
              onDocument={(key) => service.readDocument(key)}
            />
          ) : (
            <section className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <h2 className="text-ui-lg font-medium">
                {state.binding ? "选择一个任务，继续推进工作" : "选择公司后开始工作"}
              </h2>
              <p className="max-w-lg text-foreground-subtle">
                在这里查看任务、运行、审批和交付成果。所有任务都保存在你选择的服务器中
              </p>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
