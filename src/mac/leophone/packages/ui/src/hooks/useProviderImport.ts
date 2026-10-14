import { useCallback, useState } from "react";
import {
  PROVIDER_IMPORT_LIMITS,
  type ProviderImportItemResult,
  type ProviderImportResult,
} from "@zcode/shared/provider-import";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export type ProviderImportState =
  | { readonly status: "idle" }
  | { readonly status: "importing" }
  | { readonly status: "done"; readonly result: ProviderImportResult }
  | { readonly status: "failed"; readonly message: string };

/**
 * [leo] 「从 iPhone 导入」:Renderer 只读文件文本并交给 Host;解析、映射与写入都在 Host。
 * 文件内容含 API Key,这里不记录内容、不缓存,只记录文件个数。
 */
export function useProviderImport() {
  const { providerSettingsService } = useServices();
  const [state, setState] = useState<ProviderImportState>({ status: "idle" });

  const importFiles = useCallback(
    async (files: readonly File[]): Promise<ProviderImportResult | null> => {
      if (files.length === 0) return null;
      setState({ status: "importing" });
      try {
        const oversized: ProviderImportItemResult[] = [];
        const accepted: Array<{ name: string; content: string }> = [];
        for (const file of files.slice(0, PROVIDER_IMPORT_LIMITS.maxFiles)) {
          // 超限文件不读进内存,直接在结果里标为无效。
          if (file.size > PROVIDER_IMPORT_LIMITS.maxFileChars) {
            oversized.push({
              fileName: file.name,
              label: file.name,
              providerType: "",
              status: "skipped",
              reason: "invalid-file",
              detail: "file too large",
              needsKey: false,
              modelCount: 0,
            });
            continue;
          }
          accepted.push({ name: file.name, content: await file.text() });
        }
        const imported =
          accepted.length > 0
            ? await providerSettingsService.importProviders({ files: accepted })
            : { items: [] };
        const result = { items: [...imported.items, ...oversized] };
        setState({ status: "done", result });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useProviderImport] 导入服务商失败", { fileCount: files.length, message });
        setState({ status: "failed", message });
        return null;
      }
    },
    [providerSettingsService],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, importFiles, reset };
}
