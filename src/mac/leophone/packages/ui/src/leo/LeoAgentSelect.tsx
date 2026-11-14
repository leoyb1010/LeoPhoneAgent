import { ChevronDown, TerminalSquare } from "lucide-react";
import type { ModelSelectionView } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildLeoAgentChoices, type LeoAgentModelSelection } from "./leoAgentSelection.js";
import { leoAgentKindLabel, resolveLeoAgentKind } from "./leoAgentKind.js";

export function LeoAgentSelect({
  view,
  current,
  draftMode,
  disabled,
  open,
  onOpenChange,
  onSelect,
  onManage,
  onReload,
}: {
  view: ModelSelectionView | null | undefined;
  current: LeoAgentModelSelection | null;
  draftMode: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (selection: LeoAgentModelSelection) => void;
  onManage: (section?: "modelProvider" | "externalAgents") => void;
  onReload?: () => void;
}) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const kind = resolveLeoAgentKind(current);
  const label =
    !draftMode && !current?.provider
      ? zh
        ? "读取执行者…"
        : "Loading Agent…"
      : kind === "leobot"
        ? "ZCode"
        : kind === "codex"
          ? "Codex CLI"
          : leoAgentKindLabel(kind);
  const choices = buildLeoAgentChoices(view, current);
  return (
    <DropdownMenu open={draftMode && open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || !draftMode}
          data-testid="leo-agent-select"
          aria-label={`${zh ? "执行 Agent" : "Task Agent"}: ${label}`}
          title={
            !draftMode
              ? zh
                ? "当前任务的执行者已固定，新任务可选择其他 Agent"
                : "This task keeps its Agent. Choose another for a new task."
              : undefined
          }
          className="h-8 max-w-44 gap-1.5 rounded-lg border border-transparent bg-surface px-2 text-ui-sm font-medium text-foreground hover:border-border"
        >
          <TerminalSquare aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          {draftMode ? (
            <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-foreground-subtle" />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-64 rounded-xl p-1.5"
        data-testid="leo-agent-menu"
      >
        <DropdownMenuLabel className="px-2 pb-2 text-ui-sm font-normal text-foreground-subtle">
          {zh ? "选择这个任务的执行者" : "Choose this task’s Agent"}
        </DropdownMenuLabel>
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            disabled={!choice.available}
            data-testid={`leo-agent-option-${choice.id}`}
            onSelect={() => {
              if (choice.selection) onSelect(choice.selection);
            }}
            className="min-h-10 gap-2 rounded-lg px-2 text-ui-caption"
          >
            <span className="flex-1">{choice.label}</span>
            <span className="text-ui-xs text-foreground-subtle">
              {choice.id === kind
                ? zh
                  ? "当前"
                  : "Current"
                : choice.available
                  ? choice.id === "leobot"
                    ? zh
                      ? "内置"
                      : "Built in"
                    : zh
                      ? "本机 CLI"
                      : "Local CLI"
                  : zh
                    ? "尚不可用"
                    : "Unavailable"}
            </span>
          </DropdownMenuItem>
        ))}
        <p className="px-2 py-2 text-ui-xs leading-relaxed text-foreground-subtle">
          {zh
            ? "本机 CLI 使用自身的登录、模型和权限设置。"
            : "Local CLIs use their own sign-in, models and permissions."}
        </p>
        <DropdownMenuSeparator />
        {!choices[0]?.available ? (
          <DropdownMenuItem onSelect={() => onManage("modelProvider")} className="text-ui-sm">
            {zh ? "配置 ZCode 模型" : "Configure ZCode models"}
          </DropdownMenuItem>
        ) : null}
        {onReload ? (
          <DropdownMenuItem onSelect={onReload} className="text-ui-sm">
            {zh ? "刷新列表" : "Refresh list"}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onManage()} className="text-ui-sm">
          {zh ? "管理本机 Agent" : "Manage local Agents"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
