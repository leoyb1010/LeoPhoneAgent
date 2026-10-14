import { useRef, useState } from "react";
import { Loader2Icon, SmartphoneIcon } from "lucide-react";
import type { ProviderImportItemResult } from "@zcode/shared/provider-import";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderImport } from "@/hooks/useProviderImport.js";
import { markProvidersNeedingKey } from "@/settings/model-provider-section/providerImportKeyHints.js";

const STATUS_CLASS_NAME: Record<ProviderImportItemResult["status"], string> = {
  imported: "bg-success/10 text-success",
  updated: "bg-surface text-foreground-subtle",
  skipped: "bg-surface text-foreground-subtlest",
};

/**
 * [leo] 设置 → 模型供应商「从 iPhone 导入」:选择 iOS 导出的 JSON(可多选),Host 解析并写入,
 * 结果逐项列出 已导入 / 已更新 / 跳过(原因) / 需补填 Key。
 */
export function ProviderImportButton({
  onOpenProvider,
  onImported,
}: {
  onOpenProvider: (providerId: string) => void;
  onImported?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { state, importFiles, reset } = useProviderImport();
  const [open, setOpen] = useState(false);

  const handleFiles = async (fileList: FileList | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (inputRef.current) inputRef.current.value = "";
    if (files.length === 0) return;
    setOpen(true);
    const result = await importFiles(files);
    if (!result) return;
    markProvidersNeedingKey(
      result.items.flatMap((item) => (item.needsKey && item.providerId ? [item.providerId] : [])),
    );
    if (result.items.some((item) => item.status !== "skipped")) onImported?.();
  };

  const items = state.status === "done" ? state.result.items : [];

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="rounded-lg"
        data-testid="model-provider-import-ios-button"
        disabled={state.status === "importing"}
        onClick={() => inputRef.current?.click()}
      >
        {state.status === "importing" ? (
          <Loader2Icon className="animate-spin" data-icon="inline-start" aria-hidden="true" />
        ) : (
          <SmartphoneIcon data-icon="inline-start" aria-hidden="true" />
        )}
        {intl.formatMessage({ id: "settings.modelProvider.import.button" })}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        data-testid="model-provider-import-ios-input"
        onChange={(event) => void handleFiles(event.currentTarget.files)}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (state.status === "importing") return;
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent
          data-testid="model-provider-import-ios-dialog"
          className="max-h-[min(40rem,calc(100vh-4rem))] max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip"
        >
          <DialogHeader className="pr-8">
            <DialogTitle>
              {intl.formatMessage({ id: "settings.modelProvider.import.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.import.hint" })}
            </DialogDescription>
          </DialogHeader>
          <div className="-mr-3 min-h-0 overflow-y-auto pr-3">
            {state.status === "importing" ? (
              <div className="flex h-20 items-center justify-center gap-2 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.modelProvider.import.importing" })}
              </div>
            ) : state.status === "failed" ? (
              <p role="alert" className="text-ui-base text-destructive">
                {intl.formatMessage(
                  { id: "settings.modelProvider.import.failed" },
                  { detail: state.message },
                )}
              </p>
            ) : (
              <ul className="space-y-1">
                {items.map((item, index) => (
                  <ImportResultRow
                    key={`${item.fileName}:${item.label}:${index}`}
                    item={item}
                    onOpenProvider={(providerId) => {
                      setOpen(false);
                      reset();
                      onOpenProvider(providerId);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={state.status === "importing"}
              onClick={() => {
                setOpen(false);
                reset();
              }}
            >
              {intl.formatMessage({ id: "common.close" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ImportResultRow({
  item,
  onOpenProvider,
}: {
  item: ProviderImportItemResult;
  onOpenProvider: (providerId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const statusLabel = intl.formatMessage({
    id: `settings.modelProvider.import.status.${item.status}`,
  });
  const reason = item.reason
    ? intl.formatMessage({ id: `settings.modelProvider.import.reason.${item.reason}` })
    : null;
  return (
    <li
      data-testid="model-provider-import-ios-row"
      className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1"
    >
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 py-px text-ui-xs leading-normal",
          STATUS_CLASS_NAME[item.status],
        )}
      >
        {statusLabel}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui-base text-foreground" title={item.label}>
          {item.label}
        </div>
        <div className="truncate text-ui-sm text-foreground-subtle">
          {item.status === "skipped"
            ? [reason, item.detail].filter(Boolean).join(" · ")
            : intl.formatMessage(
                { id: "settings.modelProvider.import.modelCount" },
                { count: item.modelCount },
              )}
        </div>
      </div>
      {item.needsKey ? (
        <span className="shrink-0 rounded-full bg-warning/10 px-1.5 py-px text-ui-xs leading-normal text-warning">
          {intl.formatMessage({ id: "settings.modelProvider.import.needsKey" })}
        </span>
      ) : null}
      {item.providerId ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenProvider(item.providerId!)}
        >
          {intl.formatMessage({ id: "settings.modelProvider.import.open" })}
        </Button>
      ) : null}
    </li>
  );
}
