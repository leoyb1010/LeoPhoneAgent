import { useEffect, useState } from "react";
import {
  Paperclip,
  Settings2,
  PanelLeft,
  ExternalLink,
  Users,
  ChevronRight,
  Monitor,
} from "lucide-react";
import type { IPaperclipWorkspace } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { usePaperclipWorkspace } from "@/hooks/usePaperclipWorkspace.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useTheme } from "@/useTheme.js";
import { PaperclipCreateIssue } from "./CreateIssue.js";
import { PaperclipIssueDetail } from "./IssueDetail.js";
import { PaperclipNavigation } from "./Navigation.js";
import { PaperclipSettings } from "./Settings.js";
import { useDialogFocusReturn } from "./useDialogFocusReturn.js";
import "./workspace.css";

export function ServerWorkspaceRoot({
  service,
  platform,
  onReturnToLocal,
  isMacDesktop,
  isWindowsDesktop,
}: {
  service: IPaperclipWorkspace;
  platform: IPlatformService;
  onReturnToLocal: () => void;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
}) {
  const { snapshot, invoke, error } = usePaperclipWorkspace(service);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"home" | "issue" | "agents">("home");
  const [settings, setSettings] = useState(false);
  const [navigation, setNavigation] = useState(false);
  const { theme, setTheme } = useTheme();
  const navigationFocus = useDialogFocusReturn(
    "[data-pc-navigation-trigger], [data-pc-settings-trigger]",
  );
  useEffect(() => {
    setView("home");
    setNavigation(false);
  }, [snapshot.origin, snapshot.user?.id, snapshot.companyId]);
  const identity = JSON.stringify([snapshot.origin, snapshot.user?.id, snapshot.companyId]);
  const company = snapshot.companies.find((item) => item.id === snapshot.companyId);
  const filtered = snapshot.issues.filter(
    (issue) =>
      !query ||
      `${issue.title} ${issue.identifier ?? ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const unknown = Object.values(snapshot.receipts).filter((receipt) => receipt.state === "unknown");
  const home = () => {
    setView("home");
    setNavigation(false);
  };
  const sidebar = (
    <PaperclipNavigation
      snapshot={snapshot}
      filtered={filtered}
      service={service}
      invoke={invoke}
      view={view}
      setView={setView}
      query={query}
      setQuery={setQuery}
      home={home}
      setNavigation={setNavigation}
      theme={theme}
      setTheme={setTheme}
    />
  );
  return (
    <PlatformProvider platform={platform}>
      <DesktopWindowFrame
        title="Paperclip 工作台"
        isDesktop
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div className="pc-workspace flex h-full min-h-0 flex-col bg-background text-ui-base text-foreground">
          <header
            className={`pc-titlebar flex h-11 shrink-0 items-center gap-3 border-b border-border px-4 [app-region:drag] ${isMacDesktop ? "pl-20" : ""}`}
          >
            <button
              className="pc-icon pc-mobile-navigation [app-region:no-drag]"
              aria-label="打开工作台导航"
              data-pc-navigation-trigger
              onClick={() => setNavigation(true)}
            >
              <PanelLeft size={17} />
            </button>
            <button className="pc-breadcrumb [app-region:no-drag]" onClick={home}>
              {company?.name || "Paperclip 工作台"}
            </button>
            <ChevronRight size={13} className="text-foreground-subtlest" />
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">
              {view === "agents"
                ? "团队智能体"
                : view === "issue"
                  ? snapshot.detail?.issue.identifier || "任务对话"
                  : "新对话"}
            </span>
            <span
              role="status"
              className="hidden items-center gap-2 text-ui-sm text-foreground-subtlest sm:flex"
            >
              <span
                className={`pc-status-dot ${snapshot.user && !error ? "pc-status-done" : ""}`}
              />
              {snapshot.busy
                ? "同步中"
                : error
                  ? "连接需检查"
                  : snapshot.user
                    ? "已连接"
                    : "等待连接"}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5 [app-region:no-drag]"
              data-testid="paperclip-return-local"
              onClick={onReturnToLocal}
            >
              <Monitor size={14} />
              返回本机工作台
            </Button>
            <button
              className="pc-icon [app-region:no-drag]"
              aria-label="服务器设置"
              data-pc-settings-trigger
              onClick={() => setSettings(true)}
            >
              <Settings2 size={16} />
            </button>
          </header>
          <div className="flex min-h-0 flex-1">
            <aside
              className="pc-sidebar shrink-0 border-r border-border bg-sidebar"
              aria-label="工作台侧栏"
            >
              {sidebar}
            </aside>
            <main className="flex min-h-0 min-w-0 flex-1 flex-col">
              {error && (
                <div
                  role="alert"
                  className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-5 py-3 text-ui-caption"
                >
                  <span className="min-w-0 flex-1 break-words text-destructive">{error}</span>
                  <Button
                    variant="outline"
                    disabled={snapshot.busy}
                    onClick={() => void invoke(() => service.refresh())}
                  >
                    重试
                  </Button>
                </div>
              )}
              {unknown.length > 0 && (
                <details className="shrink-0 border-b border-border bg-surface px-5 py-3 text-ui-caption text-warning">
                  <summary className="cursor-pointer">
                    {unknown.length} 项提交结果待核对 · 不会自动重发
                  </summary>
                  <div className="mt-3 space-y-2">
                    {unknown.map((receipt) => (
                      <div className="flex flex-wrap items-center gap-2" key={receipt.id}>
                        <span className="min-w-0 flex-1 break-words">
                          {receipt.kind === "create"
                            ? "创建任务"
                            : receipt.kind === "comment"
                              ? "回复"
                              : receipt.kind === "approval"
                                ? "审批"
                                : receipt.kind === "cancel"
                                  ? "取消运行"
                                  : "状态变更"}
                          {receipt.targetId && ` · ${receipt.targetId}`}
                        </span>
                        <Button
                          variant="outline"
                          disabled={snapshot.busy}
                          onClick={() =>
                            void invoke(() =>
                              service.command({ kind: "archive", receiptId: receipt.id }),
                            )
                          }
                        >
                          已核对，归档
                        </Button>
                      </div>
                    ))}
                    <p className="text-foreground-subtle">
                      请先核对服务器。归档解除新提交阻塞，原操作不会重发。
                    </p>
                  </div>
                </details>
              )}
              {view === "agents" ? (
                <section className="pc-enter min-h-0 flex-1 overflow-y-auto p-6">
                  <div className="mx-auto max-w-3xl">
                    <div className="mb-6 flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <h1 className="text-ui-xl font-semibold">你的执行团队</h1>
                        <p className="mt-2 text-ui-caption text-foreground-subtle">
                          智能体与运行环境由服务器管理。
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={!snapshot.origin}
                        onClick={() => platform.openExternal(snapshot.origin)}
                      >
                        <ExternalLink size={15} />
                        打开完整管理网页
                      </Button>
                    </div>
                    <div className="divide-y divide-border">
                      {snapshot.agents.map((agent) => (
                        <div key={agent.id} className="flex items-center gap-4 py-5">
                          <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-brand">
                            <Users size={18} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="break-words font-medium">{agent.name}</p>
                            <p className="mt-1 text-ui-sm text-foreground-subtle">
                              {agent.status === "idle"
                                ? "空闲"
                                : agent.status === "active"
                                  ? "可用"
                                  : agent.status === "paused"
                                    ? "已暂停"
                                    : agent.status === "terminated"
                                      ? "已终止"
                                      : agent.status === "running"
                                        ? "运行中"
                                        : "服务器智能体"}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                    {snapshot.agents.length === 0 && (
                      <p className="py-8 text-foreground-subtle">
                        尚无可显示的智能体。连接公司后刷新，或在管理网页配置团队。
                      </p>
                    )}
                  </div>
                </section>
              ) : view === "issue" ? (
                snapshot.detail ? (
                  <PaperclipIssueDetail
                    key={`${identity}:${snapshot.detail.issue.id}`}
                    service={service}
                    snapshot={snapshot}
                    invoke={invoke}
                    onHome={home}
                  />
                ) : (
                  <section
                    className="flex flex-1 flex-col items-center justify-center gap-4 p-6"
                    aria-busy={snapshot.busy}
                  >
                    <p role="status" className="text-ui-caption text-foreground-subtle">
                      {snapshot.busy ? "正在打开任务对话…" : "暂时无法读取这段对话，请刷新后重试。"}
                    </p>
                    <Button variant="outline" onClick={home}>
                      返回新对话首页
                    </Button>
                  </section>
                )
              ) : snapshot.user && snapshot.companyId ? (
                <PaperclipCreateIssue
                  key={identity}
                  service={service}
                  snapshot={snapshot}
                  invoke={invoke}
                  onClose={() => setView("issue")}
                />
              ) : (
                <section className="pc-enter flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
                  <div className="w-full max-w-lg">
                    <span className="mb-6 flex size-12 items-center justify-center rounded-xl bg-accent text-brand">
                      <Paperclip size={25} strokeWidth={1.7} />
                    </span>
                    <p className="mb-3 text-ui-sm tracking-wide text-foreground-subtle">
                      PAPERCLIP · 团队工作台
                    </p>
                    <h1 className="text-ui-xl font-semibold">想法，从这里开始执行。</h1>
                    <p className="mt-4 text-ui-base leading-relaxed text-foreground-subtle">
                      连接你的团队，把任务、回复和执行进展放在一段连贯的对话里。
                    </p>
                    <Button className="mt-6" onClick={() => setSettings(true)}>
                      <Settings2 size={16} />
                      {snapshot.user
                        ? "选择公司"
                        : snapshot.origin
                          ? "登录并进入团队"
                          : "连接服务器"}
                    </Button>
                  </div>
                </section>
              )}
            </main>
          </div>
          <Dialog open={navigation} onOpenChange={setNavigation}>
            <DialogContent className="pc-navigation-dialog" {...navigationFocus}>
              <DialogTitle className="sr-only">工作台导航</DialogTitle>
              <DialogDescription className="sr-only">
                选择任务、新对话或服务器设置。
              </DialogDescription>
              {sidebar}
            </DialogContent>
          </Dialog>
          <PaperclipSettings
            settings={settings}
            onOpenChange={setSettings}
            snapshot={snapshot}
            service={service}
            platform={platform}
            invoke={invoke}
            error={error}
          />
        </div>
      </DesktopWindowFrame>
    </PlatformProvider>
  );
}
