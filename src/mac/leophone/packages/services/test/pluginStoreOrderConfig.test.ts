import { describe, expect, it, vi } from "vitest";
import { createClientConfigService } from "../src/client-config/clientConfigService.js";
import type { ApiClient } from "@zcode/shared";

// [leo] 公开客户端配置（插件商店排序、zsrcUrl）来自官方服务器；LeoPhoneAgent 本地化为默认快照，
// 不发任何请求。上游针对请求合并/缓存/TTL/超时/错误重试的用例随远程拉取一并移除，
// 这里只断言 Leo 行为：始终返回默认快照、从不触网。
const initialContext = {
  endpointOrigin: "https://config.example.test",
  appVersion: "3.12.1",
  platform: "darwin-arm64",
};

describe("ClientConfigService", () => {
  it("[leo] 始终返回本地默认快照，强刷和换上下文也不发请求", async () => {
    const request = vi.fn<ApiClient["request"]>();
    let context = { ...initialContext };
    const service = createClientConfigService({
      apiClient: { request },
      resolveRequestContext: async () => ({ ...context }),
    });

    const empty = { pluginStoreOrder: null, zsrcUrl: null };
    expect(await Promise.all([service.getSnapshot(), service.getSnapshot()])).toEqual([
      empty,
      empty,
    ]);
    expect(await service.getSnapshot({ forceRefresh: true })).toEqual(empty);
    context = { ...context, endpointOrigin: "https://other.example.test", appVersion: "3.13.0" };
    expect(await service.getSnapshot()).toEqual(empty);
    expect(request).not.toHaveBeenCalled();
  });
});
