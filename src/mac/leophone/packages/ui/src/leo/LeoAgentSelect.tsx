import { useId, useRef, useState } from "react";
import { ChevronDown, TerminalSquare } from "lucide-react";
import type { ModelSelectionView } from "@zcode/services";
import {
  ACP_PROVIDER_ID,
  formatAcpModelId,
  isValidAcpCustomModelId,
  parseAcpModelId,
  type AcpAgentId,
} from "@zcode/shared/acp";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
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
  draftSettings,
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
  draftSettings?: {
    model: string;
    onChooseModel?: () => void;
    onChooseMode?: () => void;
  };
}) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const kind = resolveLeoAgentKind(current);
  const cli = current?.provider === ACP_PROVIDER_ID ? parseAcpModelId(current.model) : null;
  const [editingCli, setEditingCli] = useState<AcpAgentId | null>(null);
  const [modelInput, setModelInput] = useState("");
  const modelInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingModelEditor = useRef(false);
  const inputId = useId();
  const editorOpen = !disabled && cli !== null && editingCli === cli.agentId;
  const canOpen = draftMode || cli !== null;
  const modelLabel = cli
    ? (cli.customModelId ?? (zh ? "CLI 默认" : "CLI default"))
    : draftSettings?.model;
  const modelId = modelInput.trim();
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
    <Popover
      open={editorOpen}
      onOpenChange={(next) => {
        if (!next) setEditingCli(null);
      }}
    >
      <PopoverAnchor asChild>
        <span className="inline-flex min-w-0">
          <DropdownMenu open={canOpen && open} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger asChild>
              <Button
                ref={triggerRef}
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || !canOpen}
                data-testid="leo-agent-select"
                aria-label={[zh ? "执行 Agent" : "Task Agent", label, modelLabel]
                  .filter(Boolean)
                  .join(" · ")}
                title={
                  cli?.customModelId ??
                  (!canOpen
                    ? zh
                      ? "当前任务的执行者已固定，新任务可选择其他 Agent"
                      : "This task keeps its Agent. Choose another for a new task."
                    : undefined)
                }
                className="h-8 max-w-44 gap-1.5 rounded-lg border border-transparent bg-surface px-2 text-ui-sm font-medium text-foreground hover:border-border"
              >
                <TerminalSquare aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{[label, modelLabel].filter(Boolean).join(" · ")}</span>
                {canOpen ? (
                  <ChevronDown
                    aria-hidden="true"
                    className="size-3 shrink-0 text-foreground-subtle"
                  />
                ) : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="top"
              sideOffset={8}
              className="w-64 rounded-xl p-1.5"
              data-testid="leo-agent-menu"
              onCloseAutoFocus={(event) => {
                if (openingModelEditor.current) {
                  event.preventDefault();
                  openingModelEditor.current = false;
                }
              }}
            >
              <DropdownMenuLabel className="px-2 pb-2 text-ui-sm font-normal text-foreground-subtle">
                {draftMode
                  ? zh
                    ? "选择这个任务的执行者"
                    : "Choose this task’s Agent"
                  : zh
                    ? "设置当前 CLI 的模型"
                    : "Set the model for this CLI"}
              </DropdownMenuLabel>
              {cli ? (
                <DropdownMenuItem
                  onSelect={() => {
                    openingModelEditor.current = true;
                    setModelInput(cli.customModelId ?? "");
                    setEditingCli(cli.agentId);
                  }}
                  data-testid="leo-draft-choose-model"
                >
                  {zh ? "选择 CLI 模型…" : "Choose CLI model…"}
                </DropdownMenuItem>
              ) : draftSettings?.onChooseModel ? (
                <DropdownMenuItem
                  onSelect={draftSettings.onChooseModel}
                  data-testid="leo-draft-choose-model"
                >
                  {zh ? "选择模型" : "Choose model"}
                </DropdownMenuItem>
              ) : null}
              {draftSettings?.onChooseMode ? (
                <DropdownMenuItem onSelect={draftSettings.onChooseMode}>
                  {zh ? "行为模式" : "Task mode"}
                </DropdownMenuItem>
              ) : null}
              {draftSettings?.onChooseMode ? <DropdownMenuSeparator /> : null}
              {draftMode
                ? choices.map((choice) => (
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
                  ))
                : null}
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
        </span>
      </PopoverAnchor>
      {cli ? (
        <PopoverContent
          side="top"
          sideOffset={8}
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)]"
          aria-label={zh ? "CLI 自定义模型" : "Custom CLI model"}
          data-testid="leo-cli-model-editor"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            modelInputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!editorOpen || !isValidAcpCustomModelId(modelId)) return;
              onSelect({
                provider: ACP_PROVIDER_ID,
                model: formatAcpModelId(cli.agentId, modelId),
              });
              setEditingCli(null);
            }}
          >
            <div className="space-y-1">
              <label className="text-ui-sm font-medium" htmlFor={inputId}>
                {zh ? `${label} · 模型 ID` : `${label} · Model ID`}
              </label>
              <Input
                id={inputId}
                ref={modelInputRef}
                size="lg"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                placeholder="provider/model-id"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={`${inputId}-hint`}
                data-testid="leo-cli-model-id"
              />
              <p id={`${inputId}-hint`} className="text-ui-xs text-foreground-subtle">
                {zh
                  ? "填该 CLI 已配置的模型 ID，沿用它的服务商和登录配置。"
                  : "Enter a model ID available to this CLI. Its provider and sign-in still apply."}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              {draftMode && cli.customModelId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="leo-cli-model-default"
                  onClick={() => {
                    onSelect({ provider: ACP_PROVIDER_ID, model: cli.agentId });
                    setEditingCli(null);
                  }}
                >
                  {zh ? "使用 CLI 默认" : "Use CLI default"}
                </Button>
              ) : null}
              <Button
                type="submit"
                size="sm"
                disabled={!isValidAcpCustomModelId(modelId)}
                data-testid="leo-cli-model-apply"
              >
                {zh ? "使用模型" : "Use model"}
              </Button>
            </div>
          </form>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
