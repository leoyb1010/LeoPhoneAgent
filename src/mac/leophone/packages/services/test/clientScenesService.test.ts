import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@zcode/shared";
import { createClientScenesService } from "../src/client-scenes/clientScenesService.js";

describe("ClientScenesService", () => {
  // [leo] 自动化场景模板由官方服务器下发;LeoBot 不连官方,固定返回空列表且不发请求。
  it("本地模式返回空 client scenes envelope 且不请求官方服务", async () => {
    const request = vi.fn();
    const service = createClientScenesService({
      apiClient: { request } as unknown as ApiClient,
    });

    await expect(service.list()).resolves.toEqual({ code: 0, msg: "ok", data: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
