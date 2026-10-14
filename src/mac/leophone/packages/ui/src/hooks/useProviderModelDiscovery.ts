import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelDiscoveryResult } from "@zcode/shared/model-discovery";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export type ProviderModelDiscoveryState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "done"; readonly result: ModelDiscoveryResult }
  | { readonly status: "failed"; readonly message: string };

/**
 * [leo] 设置页「从接口获取模型」。只传 providerId,Base URL / Key 由 Host 从已保存配置解析;
 * 调用前由 beforeDiscover 把卡片上未落盘的连接草稿提交掉,保证 Host 读到的是用户刚填的值。
 */
export function useProviderModelDiscovery(input: {
  readonly providerId: string;
  readonly beforeDiscover?: () => Promise<void>;
}) {
  const { providerSettingsService } = useServices();
  const [state, setState] = useState<ProviderModelDiscoveryState>({ status: "idle" });
  const requestTokenRef = useRef(0);
  const beforeDiscoverRef = useRef(input.beforeDiscover);
  beforeDiscoverRef.current = input.beforeDiscover;

  useEffect(() => {
    // 切换供应商后旧请求的结果不能落到新卡片上。
    requestTokenRef.current += 1;
    setState({ status: "idle" });
  }, [input.providerId]);

  const discover = useCallback(async (): Promise<ModelDiscoveryResult | null> => {
    const token = requestTokenRef.current + 1;
    requestTokenRef.current = token;
    setState({ status: "loading" });
    try {
      await beforeDiscoverRef.current?.();
      const result = await providerSettingsService.discoverModels({
        providerId: input.providerId,
      });
      if (token !== requestTokenRef.current) return null;
      setState({ status: "done", result });
      return result;
    } catch (error) {
      if (token !== requestTokenRef.current) return null;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[useProviderModelDiscovery] 获取模型列表失败", {
        providerId: input.providerId,
        message,
      });
      setState({ status: "failed", message });
      return null;
    }
  }, [input.providerId, providerSettingsService]);

  return { state, discover };
}
