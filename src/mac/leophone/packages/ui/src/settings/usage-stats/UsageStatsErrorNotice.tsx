import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { formatUsageErrorMessage, isUsageCredentialError } from "@/lib/usageErrorCopy.js";

export function UsageStatsErrorNotice({ error }: { error: string }) {
  const { intl } = useZCodeIntl();
  const usageErrorIsCredential = isUsageCredentialError(error);

  return (
    <div className="flex w-fit min-w-0 items-center gap-1.5 text-ui-base">
      <AlertTriangle
        className={
          usageErrorIsCredential
            ? "size-3 shrink-0 text-warning"
            : "size-3 shrink-0 text-destructive"
        }
      />
      <span
        className={
          usageErrorIsCredential
            ? "min-w-0 truncate whitespace-nowrap text-foreground"
            : "min-w-0 truncate whitespace-nowrap text-destructive"
        }
      >
        {formatUsageErrorMessage(intl, "stats", error)}
      </span>
      {usageErrorIsCredential ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 rounded-md bg-background"
          onClick={() => setPendingSettingsSection("modelProvider")}
        >
          {intl.formatMessage({ id: "settings.usage.checkApiKey" })}
        </Button>
      ) : null}
    </div>
  );
}
