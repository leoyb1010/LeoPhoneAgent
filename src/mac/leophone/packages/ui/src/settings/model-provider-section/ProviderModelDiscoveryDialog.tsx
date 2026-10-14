import { useEffect, useMemo, useState } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import {
  compareModelsNewestFirst,
  diffDiscoveredModels,
  prettifyModelId,
  resolveModelFamily,
  selectDefaultDiscoveredModels,
  type DiscoveredModel,
  type ModelDiscoveryResult,
} from "@zcode/shared/model-discovery";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import type { ProviderModelDiscoveryState } from "@/hooks/useProviderModelDiscovery.js";
import {
  DiscoveredModelRow,
  resolveDiscoveryBanner,
} from "@/settings/model-provider-section/ProviderModelDiscoveryParts.js";

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  "openai-o": "OpenAI o",
  gpt: "GPT",
};

function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? prettifyModelId(family);
}

interface ModelGroup {
  readonly family: string;
  readonly models: readonly DiscoveredModel[];
}

function groupModels(models: readonly DiscoveredModel[]): ModelGroup[] {
  const groups = new Map<string, DiscoveredModel[]>();
  for (const model of models) {
    const family = resolveModelFamily(model.id);
    groups.set(family, [...(groups.get(family) ?? []), model]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, items]) => ({ family, models: [...items].sort(compareModelsNewestFirst) }));
}

function matchesQuery(model: DiscoveredModel, query: string): boolean {
  if (!query) return true;
  const haystack = `${model.displayName} ${model.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function ProviderModelDiscoveryDialog({
  open,
  onOpenChange,
  state,
  existingModelIds,
  onRetry,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ProviderModelDiscoveryState;
  existingModelIds: readonly string[];
  onRetry: () => void;
  onConfirm: (models: DiscoveredModel[]) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const result: ModelDiscoveryResult | null = state.status === "done" ? state.result : null;
  const existing = useMemo(() => new Set(existingModelIds), [existingModelIds]);

  useEffect(() => {
    // 每次拿到新结果按「每个系列最新几款」重置默认勾选;已添加的不参与。
    if (!result) return;
    setSelected(new Set(selectDefaultDiscoveredModels(result.models, existing)));
    setAddError(null);
    // existing 只在结果到达时取快照,添加成功后列表变化不应再次重置用户的勾选。
  }, [result]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setShowAll(false);
      setAddError(null);
    }
  }, [open]);

  const hiddenCount = result?.models.filter((model) => model.hidden).length ?? 0;
  const visibleModels = useMemo(
    () =>
      (result?.models ?? []).filter(
        (model) => (showAll || !model.hidden) && matchesQuery(model, query.trim()),
      ),
    [query, result, showAll],
  );
  const groups = useMemo(() => groupModels(visibleModels), [visibleModels]);
  const selectableVisibleIds = visibleModels
    .filter((model) => !existing.has(model.id))
    .map((model) => model.id);
  const allVisibleSelected =
    selectableVisibleIds.length > 0 && selectableVisibleIds.every((id) => selected.has(id));
  const diff =
    result?.source === "endpoint" && existingModelIds.length > 0
      ? diffDiscoveredModels(result.models, existingModelIds)
      : null;
  const selectedCount = [...selected].filter((id) => !existing.has(id)).length;

  const toggle = (modelId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of selectableVisibleIds) {
        if (allVisibleSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const confirm = async () => {
    if (!result || adding) return;
    const models = result.models.filter(
      (model) => selected.has(model.id) && !existing.has(model.id),
    );
    if (models.length === 0) return;
    setAdding(true);
    setAddError(null);
    try {
      await onConfirm(models);
      onOpenChange(false);
    } catch (error) {
      setAddError(
        intl.formatMessage(
          { id: "settings.modelProvider.discovery.addFailed" },
          { detail: error instanceof Error ? error.message : String(error) },
        ),
      );
    } finally {
      setAdding(false);
    }
  };

  const banner = resolveDiscoveryBanner(intl.formatMessage, state);

  return (
    <Dialog open={open} onOpenChange={(next) => (adding ? undefined : onOpenChange(next))}>
      <DialogContent
        data-testid="model-provider-discovery-dialog"
        className="max-h-[min(44rem,calc(100vh-4rem))] max-w-xl grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-clip"
      >
        <DialogHeader className="pr-8">
          <div className="flex items-center gap-2">
            <DialogTitle>
              {intl.formatMessage({ id: "settings.modelProvider.discovery.title" })}
            </DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={state.status === "loading" || adding}
              aria-label={intl.formatMessage({ id: "settings.modelProvider.discovery.refresh" })}
              onClick={onRetry}
            >
              <RefreshCwIcon className={cn(state.status === "loading" && "animate-spin")} />
            </Button>
          </div>
          <DialogDescription className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.discovery.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {banner ? (
            <div
              role={banner.tone === "error" ? "alert" : "status"}
              className={cn(
                "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-ui-sm",
                banner.tone === "error"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-surface text-foreground-subtle",
              )}
            >
              <span className="min-w-0 break-words">{banner.message}</span>
              {banner.retry ? (
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                  {intl.formatMessage({ id: "settings.modelProvider.discovery.retry" })}
                </Button>
              ) : null}
            </div>
          ) : null}
          {diff ? (
            <div className="text-ui-sm text-foreground-subtle" data-testid="model-discovery-diff">
              {intl.formatMessage(
                { id: "settings.modelProvider.discovery.diff" },
                { added: diff.added.length, removed: diff.removed.length },
              )}
              {diff.removed.length > 0 ? (
                <div className="mt-0.5 break-all">
                  {intl.formatMessage(
                    { id: "settings.modelProvider.discovery.removedHint" },
                    { ids: diff.removed.join(", ") },
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
          {result && result.models.length > 0 ? (
            <div className="flex items-center gap-2">
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                type="search"
                className="h-7 flex-1"
                value={query}
                placeholder={intl.formatMessage({
                  id: "settings.modelProvider.discovery.searchPlaceholder",
                })}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="default"
                disabled={selectableVisibleIds.length === 0}
                onClick={toggleAllVisible}
              >
                {intl.formatMessage({
                  id: allVisibleSelected
                    ? "settings.modelProvider.discovery.clearSelection"
                    : "settings.modelProvider.discovery.selectAll",
                })}
              </Button>
            </div>
          ) : null}
          {hiddenCount > 0 ? (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-ui-sm text-foreground-subtle">
              <Checkbox
                checked={showAll}
                onCheckedChange={(checked) => setShowAll(checked === true)}
              />
              {intl.formatMessage(
                { id: "settings.modelProvider.discovery.showAll" },
                { count: hiddenCount },
              )}
            </label>
          ) : null}
        </div>

        <div className="-mr-3 min-h-0 overflow-y-auto pr-3">
          {state.status === "loading" ? (
            <div className="flex h-24 items-center justify-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.modelProvider.discovery.loading" })}
            </div>
          ) : result && result.models.length > 0 && groups.length === 0 ? (
            <div className="py-6 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.discovery.noMatch" })}
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.family} className="mb-2">
                <div className="sticky top-0 z-10 bg-popover py-1 text-ui-xs font-medium text-foreground-subtlest">
                  {familyLabel(group.family)}
                </div>
                {group.models.map((model) => (
                  <DiscoveredModelRow
                    key={model.id}
                    model={model}
                    added={existing.has(model.id)}
                    checked={existing.has(model.id) || selected.has(model.id)}
                    onCheckedChange={(next) => toggle(model.id, next)}
                  />
                ))}
              </section>
            ))
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-ui-sm text-destructive">{addError}</span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={adding}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              data-testid="model-discovery-confirm"
              disabled={selectedCount === 0 || adding || state.status === "loading"}
              onClick={() => void confirm()}
            >
              {adding ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : null}
              {intl.formatMessage(
                { id: "settings.modelProvider.discovery.confirm" },
                { count: selectedCount },
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
