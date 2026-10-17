import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetCapturedZCodeAgentTelemetryEnvForTest,
  sanitizeZCodeRuntimeEnvInPlace,
} from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { prepareZCodeTelemetryEnv } from "../src/telemetry-bootstrap.js";

describe("prepareZCodeTelemetryEnv", () => {
  afterEach(() => {
    resetCapturedZCodeAgentTelemetryEnvForTest();
  });

  // [leo] LeoBot 不做任何遥测：prepareModelTelemetryEnv 直接返回原 env（packages/telemetry/src/bootstrap.ts），
  // 不生成设备 identity、不写 telemetry-state.json；OTLP 凭据仍不得写回业务 env。
  it("不准备设备 identity、不写遥测状态，也不把 OTLP 凭据写回业务 env", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-telemetry-"));
    try {
      const env: NodeJS.ProcessEnv = {
        OTEL_EXPORTER_OTLP_HEADERS: "x-arms-license-key=secret",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/v1/traces",
        ZCODE_HOME: root,
      };
      sanitizeZCodeRuntimeEnvInPlace(env);

      const prepared = await prepareZCodeTelemetryEnv(env);

      expect(prepared.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      expect(prepared.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
      expect(prepared.ZCODE_TELEMETRY_DEVICE_MID).toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
