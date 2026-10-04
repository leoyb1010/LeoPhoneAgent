import { useEffect, useState } from "react";
import type { IPaperclipWorkspace } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { usePaperclipWorkspace } from "@/hooks/usePaperclipWorkspace.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useTheme } from "@/useTheme.js";
import { PaperclipCreateIssue } from "./CreateIssue.js";
import { PaperclipIssueDetail } from "./IssueDetail.js";
import { paperclipStatus } from "./labels.js";

export function ServerWorkspaceRoot({
  service,
  platform,
  onEnterLocalRecovery,
  isMacDesktop,
  isWindowsDesktop,
}: {
  service: IPaperclipWorkspace;
  platform: IPlatformService;
  onEnterLocalRecovery: () => void;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
}) {
  const { snapshot, invoke, error } = usePaperclipWorkspace(service);
  const [address, setAddress] = useState("");
  const [query, setQuery] = useState("");
  const [create, setCreate] = useState(false);
  const { theme, setTheme } = useTheme();
  useEffect(() => {
    setAddress(snapshot.origin);
  }, [snapshot.origin]);
  useEffect(() => {
    setCreate(false);
  }, [snapshot.origin, snapshot.user?.id, snapshot.companyId]);
  const identity = JSON.stringify([snapshot.origin, snapshot.user?.id, snapshot.companyId]);
  const filtered = snapshot.issues.filter(
    (issue) =>
      !query ||
      `${issue.title} ${issue.identifier ?? ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return (
    <PlatformProvider platform={platform}>
      <DesktopWindowFrame
        title="Paperclip 工作台"
        isDesktop
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div className="flex h-full min-h-0 flex-col p-1 text-ui-base">
          <header className="flex h-10 shrink-0 items-center gap-2 px-3 pl-20 [app-region:drag]">
            <span className="flex-1 text-ui-lg font-semibold">Paperclip 工作台</span>
            <Button
              className="[app-region:no-drag]"
              variant="ghost"
              onClick={() => setTheme(theme === "zai-dark" ? "zai-light" : "zai-dark")}
            >
              切换主题
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-1 md:flex-row">
            <aside
              className="flex max-h-[45vh] shrink-0 flex-col gap-3 rounded-lg border border-border bg-sidebar p-3 md:max-h-none md:w-72"
              aria-label="服务器与任务导航"
            >
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void invoke(() => service.configure(address));
                }}
              >
                <label className="flex flex-col gap-2 text-ui-caption">
                  服务器根地址
                  <Input
                    aria-label="服务器根地址"
                    value={address}
                    placeholder="https://paperclip.example.com"
                    onChange={(event) => setAddress(event.target.value)}
                    disabled={snapshot.busy}
                  />
                </label>
                <Button type="submit" variant="outline" disabled={snapshot.busy || !address.trim()}>
                  保存并连接
                </Button>
              </form>
              <p className="break-all text-ui-caption text-foreground-subtle">
                {snapshot.origin || "尚未配置服务器"}
              </p>
              <div className="flex gap-2">
                <Button
                  disabled={snapshot.busy || !snapshot.origin}
                  onClick={() => void invoke(() => service.signIn())}
                >
                  {snapshot.user ? "重新登录" : "网页登录"}
                </Button>
                {snapshot.user && (
                  <Button
                    variant="outline"
                    disabled={snapshot.busy}
                    onClick={() => void invoke(() => service.signOut())}
                  >
                    退出
                  </Button>
                )}
              </div>
              {snapshot.user && (
                <>
                  <p className="break-words text-ui-caption">
                    当前用户：{snapshot.user.name ?? snapshot.user.email ?? snapshot.user.id}
                  </p>
                  <label className="flex flex-col gap-2 text-ui-caption">
                    公司
                    <select
                      aria-label="公司"
                      className="rounded-md border border-input-border bg-input p-2 text-ui-base"
                      value={snapshot.companyId}
                      disabled={snapshot.busy}
                      onChange={(event) =>
                        void invoke(() => service.selectCompany(event.target.value))
                      }
                    >
                      {snapshot.companies.map((company) => (
                        <option key={company.id} value={company.id}>
                          {company.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {snapshot.companies.length === 0 && (
                    <p className="text-ui-caption text-foreground-subtle">
                      当前账号没有可访问的公司，请在服务器完成设置。
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      disabled={snapshot.busy || !snapshot.companyId}
                      onClick={() => setCreate(true)}
                    >
                      新建任务
                    </Button>
                    <Button
                      variant="outline"
                      disabled={snapshot.busy || !snapshot.companyId}
                      onClick={() => void invoke(() => service.refresh())}
                    >
                      刷新
                    </Button>
                  </div>
                  <Input
                    aria-label="搜索已加载任务"
                    placeholder="搜索已加载任务"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </>
              )}
              <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="服务器任务">
                {filtered.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    aria-pressed={!create && snapshot.selectedIssueId === issue.id}
                    disabled={snapshot.busy}
                    onClick={() => {
                      setCreate(false);
                      void invoke(() => service.selectIssue(issue.id));
                    }}
                    className={`mb-1 flex w-full flex-col gap-1 rounded-md p-2 text-left text-ui-base hover:bg-surface-hover disabled:opacity-50 ${!create && snapshot.selectedIssueId === issue.id ? "bg-selected" : ""}`}
                  >
                    <span className="break-words">{issue.title}</span>
                    <span className="text-ui-caption text-foreground-subtle">
                      {issue.identifier} · {paperclipStatus(issue.status)}
                    </span>
                  </button>
                ))}
                {snapshot.user && !filtered.length && (
                  <p className="text-ui-caption text-foreground-subtle">暂无匹配任务</p>
                )}
                {snapshot.hasMore && (
                  <Button
                    variant="outline"
                    disabled={snapshot.busy}
                    onClick={() => void invoke(() => service.refresh(true))}
                  >
                    加载更多任务
                  </Button>
                )}
              </nav>
              <Button variant="ghost" onClick={onEnterLocalRecovery}>
                进入本地历史恢复
              </Button>
            </aside>
            <main className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border bg-background">
              <div className="border-b border-border px-4 py-2 text-ui-caption text-foreground-subtle">
                {snapshot.busy ? "正在同步…" : "服务器任务由 Paperclip 执行；前台每 15 秒刷新"}
              </div>
              {error && (
                <div
                  role="alert"
                  className="border-b border-border bg-surface p-3 text-ui-base text-destructive"
                >
                  {error}
                </div>
              )}
              {Object.values(snapshot.receipts).some((receipt) => receipt.state === "unknown") && (
                <div
                  role="status"
                  className="border-b border-border p-3 text-ui-caption text-warning"
                >
                  有提交结果待核对，请刷新查看服务器状态。未知提交不会自动重发。
                  {Object.values(snapshot.receipts)
                    .filter((receipt) => receipt.state === "unknown")
                    .map((receipt) => (
                      <div key={receipt.id} className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 break-all">
                          {receipt.kind === "create"
                            ? "创建任务"
                            : receipt.kind === "comment"
                              ? "回复"
                              : receipt.kind === "approval"
                                ? "审批决定"
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
                          已人工核对，归档此操作
                        </Button>
                      </div>
                    ))}
                  <p className="mt-2">归档仅保留核对记录并解除新提交阻塞，不会重发原操作。</p>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {create && snapshot.user ? (
                  <PaperclipCreateIssue
                    key={identity}
                    service={service}
                    snapshot={snapshot}
                    invoke={invoke}
                    onClose={() => setCreate(false)}
                  />
                ) : snapshot.detail ? (
                  <PaperclipIssueDetail
                    key={`${identity}:${snapshot.detail.issue.id}`}
                    service={service}
                    snapshot={snapshot}
                    invoke={invoke}
                  />
                ) : (
                  <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
                    <h2 className="text-ui-xl font-semibold">服务器工作区</h2>
                    <p>保存 HTTPS 地址并用人类账号网页登录，再选择公司和任务。</p>
                    <p className="text-ui-caption text-foreground-subtle">
                      服务器不可用或登录过期会停止并提示。任务不会转为本机执行，已有本机会话可从历史恢复入口继续。
                    </p>
                  </div>
                )}
              </div>
            </main>
          </div>
        </div>
      </DesktopWindowFrame>
    </PlatformProvider>
  );
}
