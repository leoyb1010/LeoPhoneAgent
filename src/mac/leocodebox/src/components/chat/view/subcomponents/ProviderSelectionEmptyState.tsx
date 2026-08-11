import React, { useCallback, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import type {
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from "../../../../types/app";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import { NextTaskBanner } from "../../../task-master";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Card,
} from "../../../../shared/view/ui";

const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
  { id: "grok", name: "xAI" },
];

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

// cmdk's default filter is fuzzy (loose character-subsequence scoring), which
// surfaces unrelated models — e.g. searching "chatgpt" also matched "Fable".
// Require every whitespace-separated search token to appear as a literal
// substring instead, so "claude 4.5" still matches "Anthropic Claude Haiku 4.5"
// but "chatgpt" only matches models that actually contain it.
function modelSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  grokModel: string;
  setGrokModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

function getCurrentModel(
  p: LLMProvider,
  c: string,
  cu: string,
  co: string,
  o: string,
  g: string,
) {
  if (p === "claude") return c;
  if (p === "codex") return co;
  if (p === "opencode") return o;
  if (p === "grok") return g;
  return cu;
}

function getProviderDisplayName(p: LLMProvider) {
  if (p === "claude") return "Claude";
  if (p === "cursor") return "Cursor";
  if (p === "codex") return "Codex";
  if (p === "opencode") return "OpenCode";
  if (p === "grok") return "Grok";
  return "Claude";
}

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  opencodeModel,
  setOpenCodeModel,
  grokModel,
  setGrokModel,
  providerModelCatalog,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const [dialogOpen, setDialogOpen] = useState(false);
  // Two-step selector: pick the CLI first, then that CLI's model. `step`
  // toggles which pane the dialog shows; `pendingProvider` remembers the CLI
  // chosen in step 1 so step 2 only lists its models.
  const [step, setStep] = useState<"provider" | "model">("provider");
  const [pendingProvider, setPendingProvider] = useState<LLMProvider>(provider);

  const modelForProvider = useCallback(
    (id: LLMProvider) =>
      getCurrentModel(id, claudeModel, cursorModel, codexModel, opencodeModel, grokModel),
    [claudeModel, cursorModel, codexModel, opencodeModel, grokModel],
  );

  const labelForProviderModel = useCallback(
    (id: LLMProvider) => {
      const value = modelForProvider(id);
      const found = providerModelCatalog[id]?.OPTIONS.find((o) => o.value === value);
      return found?.label || value;
    },
    [modelForProvider, providerModelCatalog],
  );

  const openDialog = useCallback(
    (open: boolean) => {
      setDialogOpen(open);
      if (open) {
        // Always start on the CLI list, pre-focused on the active provider.
        setStep("provider");
        setPendingProvider(provider);
      }
    },
    [provider],
  );

  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const currentModel = getCurrentModel(
    provider,
    claudeModel,
    cursorModel,
    codexModel,
    opencodeModel,
    grokModel,
  );

  const currentModelLabel = useMemo(() => {
    const config = getModelConfig(provider, providerModelCatalog);
    const found = config.OPTIONS.find(
      (o: { value: string; label: string }) => o.value === currentModel,
    );
    return found?.label || currentModel;
  }, [provider, currentModel, providerModelCatalog]);

  const setModelForProvider = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      if (providerId === "claude") {
        setClaudeModel(modelValue);
        localStorage.setItem("claude-model", modelValue);
      } else if (providerId === "codex") {
        setCodexModel(modelValue);
        localStorage.setItem("codex-model", modelValue);
      } else if (providerId === "opencode") {
        setOpenCodeModel(modelValue);
        localStorage.setItem("opencode-model", modelValue);
      } else if (providerId === "grok") {
        setGrokModel(modelValue);
        localStorage.setItem("grok-model", modelValue);
      } else {
        setCursorModel(modelValue);
        localStorage.setItem("cursor-model", modelValue);
      }
    },
    [setClaudeModel, setCursorModel, setCodexModel, setOpenCodeModel, setGrokModel],
  );

  // Step 1 → step 2: remember the CLI and reveal its model list.
  const handleProviderPick = useCallback((id: LLMProvider) => {
    setPendingProvider(id);
    setStep("model");
  }, []);

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string) => {
      setProvider(providerId);
      localStorage.setItem("selected-provider", providerId);
      setModelForProvider(providerId, modelValue);
      setDialogOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, setModelForProvider, textareaRef],
  );

  const pendingModels = useMemo(
    () => providerModelCatalog[pendingProvider]?.OPTIONS ?? [],
    [providerModelCatalog, pendingProvider],
  );

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[1.05fr_.95fr] lg:gap-12">
          <picture className="order-2 block overflow-hidden rounded-lg border border-border/60 bg-muted/20 shadow-elevation-1 lg:order-1">
            <source media="(prefers-color-scheme: dark)" srcSet="/visuals/onboarding/local-workbench-dark.webp" />
            <img src="/visuals/onboarding/local-workbench-light.webp" alt="" className="aspect-[16/10] w-full object-cover" />
          </picture>
          <div className="order-1 lg:order-2">
          <div className="mb-8 text-left">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("providerSelection.description")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={openDialog}>
            <DialogTrigger asChild>
              <Card
                className="group max-w-sm cursor-pointer border-border/60 transition-all duration-fast hover:border-border hover:shadow-elevation-2 active:scale-[0.99]"
              >
                <div className="flex items-center gap-2 p-3">
                  <SessionProviderLogo
                    provider={provider}
                    className="h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        {getProviderDisplayName(provider)}
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {currentModelLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle className="sr-only">
                {step === "provider"
                  ? t("providerSelection.chooseCli", { defaultValue: "Choose a CLI" })
                  : t("providerSelection.chooseModelFor", {
                      provider: getProviderDisplayName(pendingProvider),
                      defaultValue: "Choose a {{provider}} model",
                    })}
              </DialogTitle>

              {step === "provider" ? (
                <>
                  <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
                    <p className="text-sm font-semibold text-foreground">
                      {t("providerSelection.chooseCli", { defaultValue: "Choose a CLI" })}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.chooseCliHint", {
                        defaultValue: "Pick a coding agent, then its model",
                      })}
                    </p>
                  </div>
                  <Command>
                    <CommandList className="max-h-[350px]">
                      <CommandGroup className="[&_[cmdk-group-heading]]:hidden">
                        {PROVIDER_META.map((p) => {
                          const isActive = provider === p.id;
                          return (
                            <CommandItem
                              key={p.id}
                              value={`${getProviderDisplayName(p.id)} ${p.name}`}
                              onSelect={() => handleProviderPick(p.id)}
                              className="gap-2.5 py-2.5"
                            >
                              <SessionProviderLogo provider={p.id} className="h-5 w-5 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-medium text-foreground">
                                    {getProviderDisplayName(p.id)}
                                  </span>
                                  <span className="text-[11px] text-muted-foreground">{p.name}</span>
                                </div>
                                <div className="truncate text-[11px] text-muted-foreground">
                                  {labelForProviderModel(p.id)}
                                </div>
                              </div>
                              {isActive && (
                                <Check className="h-4 w-4 shrink-0 text-primary" />
                              )}
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setStep("provider")}
                    className="flex w-full items-center gap-2 border-b border-border/60 bg-muted/20 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <SessionProviderLogo provider={pendingProvider} className="h-4 w-4 shrink-0" />
                    <span className="text-sm font-semibold text-foreground">
                      {getProviderDisplayName(pendingProvider)}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {t("providerSelection.back", { defaultValue: "Back" })}
                    </span>
                  </button>
                  <Command filter={modelSearchFilter}>
                    <CommandInput
                      placeholder={t("providerSelection.searchModels", {
                        defaultValue: "Search models...",
                      })}
                    />
                    <CommandList className="max-h-[350px]">
                      <CommandEmpty>
                        {providerModelsLoading
                          ? t("providerSelection.loadingModels", { defaultValue: "Loading models…" })
                          : t("providerSelection.noModelsFound", { defaultValue: "No models found." })}
                      </CommandEmpty>
                      <CommandGroup className="[&_[cmdk-group-heading]]:hidden">
                        {pendingModels.map((model) => {
                          const isSelected =
                            provider === pendingProvider && currentModel === model.value;
                          return (
                            <CommandItem
                              key={`${pendingProvider}-${model.value}`}
                              value={`${model.label} ${model.description || ""}`}
                              onSelect={() => handleModelSelect(pendingProvider, model.value)}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate">{model.label}</div>
                              </div>
                              {isSelected && (
                                <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                              )}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </>
              )}
            </DialogContent>
          </Dialog>

          <p className="mt-4 text-center text-sm text-muted-foreground/70">
            {
              {
                claude: t("providerSelection.readyPrompt.claude", {
                  model: claudeModel,
                }),
                cursor: t("providerSelection.readyPrompt.cursor", {
                  model: cursorModel,
                }),
                codex: t("providerSelection.readyPrompt.codex", {
                  model: codexModel,
                }),
                opencode: t("providerSelection.readyPrompt.opencode", {
                  model: opencodeModel,
                  defaultValue: "Ready with OpenCode {{model}}",
                }),
                grok: t("providerSelection.readyPrompt.grok", {
                  model: grokModel,
                  defaultValue: "Ready with Grok {{model}}",
                }),
              }[provider]
            }
          </p>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
            <Trans
              ns="chat"
              i18nKey="providerSelection.pressToSearch"
              values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
              components={{
                kbd: (
                  <kbd className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                ),
              }}
            />
          </p>

          {provider && tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
          </div>
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-[34.25rem] px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
