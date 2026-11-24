import { useId, useRef, useState } from "react";
import { Check, ChevronDown, Search, TerminalSquare } from "lucide-react";
import type { ModelSelectionView } from "@zcode/services";
import {
  ACP_PROVIDER_ID,
  acpAgentInfo,
  formatAcpModelId,
  isValidAcpCustomModelId,
  parseAcpModelId,
  type AcpAgentId,
} from "@zcode/shared/acp";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildLeoAgentChoices,
  isSameLeoAgentRoute,
  listLeoConfiguredModels,
  type LeoAgentModelSelection,
} from "./leoAgentSelection.js";
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
  const [query, setQuery] = useState("");
  const [modelInput, setModelInput] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const editorOpen = !disabled && cli !== null && editingCli === cli.agentId;
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
  const needle = query.trim().toLowerCase();
  const configuredModels = cli ? listLeoConfiguredModels(view, cli.agentId) : [];
  const visibleModels = configuredModels.filter(({ providerName, modelId }) =>
    `${modelId} ${providerName}`.toLowerCase().includes(needle),
  );
  const selectModel = (selection: LeoAgentModelSelection) => {
    setEditingCli(null);
    onSelect(selection);
  };
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <DropdownMenu open={draftMode && open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || !draftMode}
            data-testid="leo-agent-select"
            aria-label={`${zh ? "执行 Agent" : "Task Agent"} · ${label}`}
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
              ? "选择已配置模型时，执行器会按供应商自动匹配。"
              : "Choosing a saved model matches the Agent to its provider."}
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
      {cli ? (
        <Popover
          open={editorOpen}
          onOpenChange={(next) => {
            setEditingCli(next ? cli.agentId : null);
            if (next) {
              setQuery("");
              setModelInput(cli.configuredProviderId ? "" : (cli.customModelId ?? ""));
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              data-testid="leo-cli-model-select"
              aria-label={[zh ? "选择模型" : "Choose model", cli.customModelId, label]
                .filter(Boolean)
                .join(" · ")}
              title={
                cli.customModelId ??
                (zh ? "当前使用 CLI 默认模型" : "Current model follows the CLI default")
              }
              className="h-8 max-w-48 min-w-0 gap-1.5 rounded-lg px-2 text-ui-sm font-medium"
            >
              <span className="truncate">
                {cli.customModelId ?? (zh ? "选择模型" : "Choose model")}
              </span>
              <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-foreground-subtle" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="w-96 max-w-[calc(100vw-2rem)] space-y-2 p-2.5"
            aria-label={zh ? "选择已配置模型" : "Choose a saved model"}
            data-testid="leo-cli-model-editor"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
          >
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-foreground-subtle"
              />
              <Input
                ref={searchRef}
                size="lg"
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={zh ? "搜索模型或供应商" : "Search models or providers"}
                aria-label={zh ? "搜索模型或供应商" : "Search models or providers"}
                autoComplete="off"
              />
            </div>
            <div
              className="max-h-[min(16rem,40vh)] space-y-0.5 overflow-y-auto"
              data-testid="leo-configured-models"
            >
              {visibleModels.map(
                ({ providerId, providerName, modelId, agent, enabled, selection }) => {
                  const selected =
                    selection.provider === current?.provider && selection.model === current.model;
                  const locked =
                    !draftMode && current !== null && !isSameLeoAgentRoute(current, selection);
                  return (
                    <Button
                      key={JSON.stringify([providerId, modelId])}
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!enabled || locked}
                      aria-pressed={selected}
                      title={
                        locked
                          ? zh
                            ? "在新任务中使用此执行路径"
                            : "Use this route in a new task"
                          : undefined
                      }
                      className="h-auto min-h-11 w-full justify-start gap-2 px-2 text-left"
                      onClick={() => selectModel(selection)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-ui-sm" title={modelId}>
                          {modelId}
                        </span>
                        <span className="truncate text-ui-xs text-foreground-subtle">
                          {providerName} ·{" "}
                          {agent === "codex"
                            ? "Codex CLI"
                            : agent
                              ? acpAgentInfo(agent).name
                              : "ZCode"}
                        </span>
                      </span>
                      {selected ? (
                        <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                      ) : null}
                    </Button>
                  );
                },
              )}
              {!visibleModels.length ? (
                <p className="px-2 py-3 text-ui-sm text-foreground-subtle">
                  {configuredModels.length
                    ? zh
                      ? "没有匹配的模型"
                      : "No matching models"
                    : zh
                      ? "还没有可用的已配置模型"
                      : "No saved models available"}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1 border-t border-border pt-1.5">
              {draftMode || !cli.customModelId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={!cli.customModelId}
                  data-testid="leo-cli-model-default"
                  onClick={() => selectModel({ provider: ACP_PROVIDER_ID, model: cli.agentId })}
                >
                  {zh ? "CLI 默认" : "CLI default"}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditingCli(null);
                  onManage("modelProvider");
                }}
              >
                {zh ? "管理供应商" : "Manage providers"}
              </Button>
            </div>
            {draftMode || !cli.configuredProviderId ? (
              <details>
                <summary className="cursor-pointer rounded-md px-2 py-1.5 text-ui-xs text-foreground-subtle">
                  {zh ? "输入 CLI 原生模型 ID" : "Enter a native CLI model ID"}
                </summary>
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!editorOpen || !isValidAcpCustomModelId(modelId)) return;
                    selectModel({
                      provider: ACP_PROVIDER_ID,
                      model: formatAcpModelId(cli.agentId, modelId),
                    });
                  }}
                >
                  <div className="space-y-1">
                    <label className="text-ui-sm font-medium" htmlFor={inputId}>
                      {zh ? `${label} · 模型 ID` : `${label} · Model ID`}
                    </label>
                    <Input
                      id={inputId}
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
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!isValidAcpCustomModelId(modelId)}
                    data-testid="leo-cli-model-apply"
                    className="ml-auto flex"
                  >
                    {zh ? "使用模型" : "Use model"}
                  </Button>
                </form>
              </details>
            ) : null}
          </PopoverContent>
        </Popover>
      ) : draftSettings?.onChooseModel ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={draftSettings.onChooseModel}
          data-testid="leo-draft-choose-model"
          aria-label={zh ? "选择模型" : "Choose model"}
          title={draftSettings.model}
          className="h-8 max-w-48 min-w-0 gap-1.5 rounded-lg px-2 text-ui-sm font-medium"
        >
          <span className="truncate">{draftSettings.model}</span>
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-foreground-subtle" />
        </Button>
      ) : null}
    </span>
  );
}
