import { describe, expect, it } from "vitest";
import { exampleGenUiPrepare } from "./contract.example.js";
import { IGenUiService, type GenUiPrepareParams } from "./contract.js";

// [leo] 上游 3.15.1 的 gen-ui-service 模块缺这份契约测试，architecture:check 的
// missing-module-artifact 会红；这里补齐最小契约：描述符频道与示例入参形态。
describe("gen-ui-service contract", () => {
  it("描述符绑定 gen-ui 频道", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("示例入参只用契约字段：目标定位 + HTML + 宿主 webContents + 实例键", () => {
    const params: GenUiPrepareParams = exampleGenUiPrepare;
    expect(Object.keys(params).sort()).toEqual(
      ["html", "instanceKey", "ownerWebContentsId", "path", "sessionId", "workspacePath"].sort(),
    );
    expect(params.html).toContain("<div");
  });
});
