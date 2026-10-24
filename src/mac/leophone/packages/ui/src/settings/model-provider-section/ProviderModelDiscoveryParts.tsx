import type { DiscoveredModel } from "@zcode/shared/model-discovery";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
import type { ProviderModelDiscoveryState } from "@/hooks/useProviderModelDiscovery.js";

const BADGE_CLASS_NAME =
  "shrink-0 rounded-full bg-surface px-1.5 py-px text-ui-xs leading-normal text-foreground-subtle";

/** 一行 32px:勾选框、展示名、等宽原始 ID、能力徽标。已添加的勾上并禁用。 */
export function DiscoveredModelRow({
  model,
  added,
  latest = false,
  checked,
  onCheckedChange,
}: {
  model: DiscoveredModel;
  added: boolean;
  /** 这一品牌最新的一款:标「最新」。 */
  latest?: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <label
      data-testid="model-discovery-row"
      className={cn(
        "flex h-8 items-center gap-2 rounded-md px-2 transition-colors duration-150",
        added ? "cursor-default opacity-60" : "cursor-pointer hover:bg-surface-hover",
        checked && !added && "bg-surface/60",
      )}
    >
      <Checkbox
        checked={checked}
        disabled={added}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span className="min-w-0 shrink truncate text-ui-base text-foreground">
        {model.displayName}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle"
        title={model.id}
      >
        {model.id}
      </span>
      {latest ? (
        <span
          data-testid="model-discovery-latest"
          className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-ui-xs leading-normal text-primary"
        >
          {intl.formatMessage({ id: "settings.modelProvider.discovery.latest" })}
        </span>
      ) : null}
      {added ? (
        <span className={BADGE_CLASS_NAME}>
          {intl.formatMessage({ id: "settings.modelProvider.discovery.added" })}
        </span>
      ) : null}
      {model.capabilities?.vision ? (
        <span className={BADGE_CLASS_NAME}>
          {intl.formatMessage({ id: "settings.modelProvider.discovery.capability.vision" })}
        </span>
      ) : null}
      {model.capabilities?.reasoning ? (
        <span className={BADGE_CLASS_NAME}>
          {intl.formatMessage({ id: "settings.modelProvider.discovery.capability.reasoning" })}
        </span>
      ) : null}
      {model.contextWindow ? (
        <span className={BADGE_CLASS_NAME}>
          {formatModelContextWindowLabel(model.contextWindow)}
        </span>
      ) : null}
    </label>
  );
}

export function resolveDiscoveryBanner(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  state: ProviderModelDiscoveryState,
): { message: string; tone: "info" | "error"; retry: boolean } | null {
  if (state.status === "failed") {
    return {
      message: formatMessage(
        { id: "settings.modelProvider.discovery.error.unknown" },
        { detail: state.message },
      ),
      tone: "error",
      retry: true,
    };
  }
  if (state.status !== "done") return null;
  const { error, source, models } = state.result;
  if (!error) {
    return models.length === 0
      ? {
          message: formatMessage({ id: "settings.modelProvider.discovery.empty" }),
          tone: "info",
          retry: false,
        }
      : null;
  }
  const detail = error.message;
  switch (error.kind) {
    case "auth":
      return {
        message: formatMessage({ id: "settings.modelProvider.discovery.error.auth" }, { detail }),
        tone: "error",
        retry: true,
      };
    case "not_supported":
      return {
        message: formatMessage({
          id:
            models.length === 0
              ? "settings.modelProvider.discovery.error.notSupportedEmpty"
              : source === "catalog"
                ? "settings.modelProvider.discovery.error.notSupportedCatalog"
                : "settings.modelProvider.discovery.error.notSupportedBuiltin",
        }),
        tone: models.length === 0 ? "error" : "info",
        retry: false,
      };
    case "network":
    case "tls":
      return {
        message: formatMessage(
          { id: `settings.modelProvider.discovery.error.${error.kind}` },
          { detail },
        ),
        tone: "error",
        retry: true,
      };
    default:
      return {
        message:
          detail === "missing-base-url"
            ? formatMessage({ id: "settings.modelProvider.discovery.missingBaseUrl" })
            : formatMessage({ id: "settings.modelProvider.discovery.error.unknown" }, { detail }),
        tone: "error",
        retry: detail !== "missing-base-url",
      };
  }
}
