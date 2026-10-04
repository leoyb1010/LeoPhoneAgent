import type { Dispatch, SetStateAction } from "react";
import {
  Paperclip,
  Plus,
  Search,
  Settings2,
  RefreshCw,
  Moon,
  Sun,
  Users,
  MessageSquare,
  ArrowLeft,
} from "lucide-react";
import type { IPaperclipWorkspace, PaperclipSnapshot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { paperclipStatus } from "./labels.js";
export function PaperclipNavigation({
  snapshot,
  filtered,
  service,
  invoke,
  view,
  setView,
  query,
  setQuery,
  home,
  setNavigation,
  setSettings,
  onEnterLocalRecovery,
  theme,
  setTheme,
}: {
  snapshot: PaperclipSnapshot;
  filtered: PaperclipSnapshot["issues"];
  service: IPaperclipWorkspace;
  invoke: (action: () => Promise<void>) => Promise<boolean>;
  view: "home" | "issue" | "agents";
  setView: Dispatch<SetStateAction<"home" | "issue" | "agents">>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  home: () => void;
  setNavigation: Dispatch<SetStateAction<boolean>>;
  setSettings: Dispatch<SetStateAction<boolean>>;
  onEnterLocalRecovery: () => void;
  theme: string;
  setTheme: (theme: "zai-dark" | "zai-light") => void;
}) {
  return (
    <div className="pc-navigation flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 px-4 py-4">
        <span className="pc-mark flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-brand">
          <Paperclip size={19} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui-base font-semibold">Paperclip</p>
          <p className="truncate text-ui-sm text-foreground-subtle">团队的执行工作台</p>
        </div>
      </div>
      {snapshot.user && snapshot.companies.length > 0 && (
        <label className="mx-3 mb-3 block">
          <span className="sr-only">公司</span>
          <select
            aria-label="公司"
            className="pc-select w-full"
            value={snapshot.companyId}
            disabled={snapshot.busy}
            onChange={(event) => void invoke(() => service.selectCompany(event.target.value))}
          >
            {snapshot.companies.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <nav className="flex flex-col gap-1 px-3" aria-label="工作台导航">
        <button
          className="pc-nav-row"
          aria-current={view === "home" ? "page" : undefined}
          onClick={home}
        >
          <Plus size={17} />
          <span>新对话</span>
        </button>
        <button
          className="pc-nav-row"
          aria-current={view === "agents" ? "page" : undefined}
          onClick={() => {
            setView("agents");
            setNavigation(false);
          }}
        >
          <Users size={17} />
          <span>团队代理</span>
          <span className="ml-auto text-ui-sm text-foreground-subtlest">
            {snapshot.agents.length}
          </span>
        </button>
      </nav>
      <div className="mt-6 flex items-center justify-between px-4 pb-2">
        <h2 className="text-ui-sm font-medium text-foreground-subtle">任务与对话</h2>
        <button
          className="pc-icon"
          aria-label="刷新任务"
          disabled={snapshot.busy || !snapshot.companyId}
          onClick={() => void invoke(() => service.refresh())}
        >
          <RefreshCw size={14} className={snapshot.busy ? "pc-spin" : ""} />
        </button>
      </div>
      {snapshot.user && (
        <div className="relative mx-3 mb-2">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-3 text-foreground-subtlest"
          />
          <Input
            aria-label="搜索已加载任务"
            className="h-9 border-transparent bg-transparent pl-8 text-ui-sm"
            placeholder="搜索任务…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="服务器任务">
        {filtered.map((issue) => (
          <button
            key={issue.id}
            type="button"
            className="pc-task"
            aria-current={
              view === "issue" && snapshot.selectedIssueId === issue.id ? "page" : undefined
            }
            disabled={snapshot.busy}
            onClick={() => {
              setView("issue");
              setNavigation(false);
              void invoke(() => service.selectIssue(issue.id));
            }}
          >
            <MessageSquare size={15} className="mt-0.5 shrink-0 text-foreground-subtlest" />
            <span className="min-w-0">
              <span className="line-clamp-2 text-ui-base">{issue.title}</span>
              <span className="mt-1 flex items-center gap-1.5 text-ui-sm text-foreground-subtle">
                <span className={`pc-status-dot pc-status-${issue.status}`} />
                {issue.identifier || "任务"}
                <span>·</span>
                {paperclipStatus(issue.status)}
              </span>
            </span>
          </button>
        ))}
        {!filtered.length && (
          <p className="px-2 py-5 text-ui-sm leading-relaxed text-foreground-subtlest">
            {query
              ? "没有匹配的已加载任务"
              : snapshot.user
                ? "你的第一段任务对话，从这里开始。"
                : "连接团队后，这里会显示任务。"}
          </p>
        )}
        {snapshot.hasMore && (
          <Button
            variant="ghost"
            className="w-full"
            disabled={snapshot.busy}
            onClick={() => void invoke(() => service.refresh(true))}
          >
            加载更多
          </Button>
        )}
      </nav>
      <div className="space-y-1 border-t border-border px-3 py-3">
        <button
          className="pc-nav-row"
          onClick={() => {
            setSettings(true);
            setNavigation(false);
          }}
        >
          <Settings2 size={16} />
          <span>服务器与账号</span>
          <span className={`ml-auto pc-status-dot ${snapshot.user ? "pc-status-done" : ""}`} />
        </button>
        <button className="pc-nav-row text-foreground-subtle" onClick={onEnterLocalRecovery}>
          <ArrowLeft size={16} />
          <span>本地历史恢复</span>
        </button>
        <div className="flex items-center gap-2 px-2 pt-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-ui-xs font-semibold">
            {(snapshot.user?.name || "访").slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">
            {snapshot.user?.name || snapshot.user?.email || "尚未登录"}
          </span>
          <button
            className="pc-icon"
            aria-label="切换主题"
            onClick={() => setTheme(theme === "zai-dark" ? "zai-light" : "zai-dark")}
          >
            {theme === "zai-dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
