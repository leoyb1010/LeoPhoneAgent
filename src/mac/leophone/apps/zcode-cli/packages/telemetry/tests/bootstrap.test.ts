import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTelemetryRuntimeOwner } from "@zcode/contracts/telemetry";
import {
  createModelTelemetry,
  parseOtlpHeaders,
  prepareModelTelemetryEnv,
  resolveOtlpMetricEndpoint,
  resolveOtlpTraceEndpoint,
  shutdownPreparedModelTelemetry,
} from "../src/bootstrap.js";
import { NoopAgentExecutionTelemetry } from "../src/agent-trace-runtime.js";

afterEach(async () => {
  await shutdownPreparedModelTelemetry();
});

describe("Telemetry V4 bootstrap", () => {
  it("显式注入的进程 Owner 优先，Session 关闭只 abandon + flush", async () => {
    const execution = new NoopAgentExecutionTelemetry();
    const flush = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {});
    const abandon = vi.spyOn(execution, "abandonSession");
    const owner: AgentTelemetryRuntimeOwner = {
      abandonSession: abandon,
      agentExecution: execution,
      enabled: true,
      flush,
      modelExecution: execution,
      shutdown,
      updateIdentity() {},
    };

    const telemetry = createModelTelemetry({ owner, sessionId: "session-1" });
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.agentExecution).toBe(execution);
    await telemetry.shutdown();
    expect(abandon).toHaveBeenCalledWith("session-1");
    expect(flush).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("disabled 路径不需要 endpoint，也提供安全 Noop Port", async () => {
    const telemetry = createModelTelemetry();
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.agentExecution.captureCausation()).toBeUndefined();
    await telemetry.shutdown();
  });

  it("遵循 OTLP traces/metrics/common endpoint 与 percent-encoded header 规则", () => {
    expect(
      resolveOtlpTraceEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/v1/traces",
      }),
    ).toBe("https://arms.example/v1/traces");
    expect(
      resolveOtlpTraceEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example/otlp/",
      }),
    ).toBe("https://arms.example/otlp/v1/traces");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example/v1/metrics",
      }),
    ).toBe("https://arms.example/v1/metrics");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example/otlp/",
      }),
    ).toBe("https://arms.example/otlp/v1/metrics");
    expect(
      resolveOtlpMetricEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/apm/trace/opentelemetry",
      }),
    ).toBe("https://arms.example/apm/trace/opentelemetry");
    expect(parseOtlpHeaders("x-a=one%2Ctwo,x-b=hello%20world")).toEqual({
      "x-a": "one,two",
      "x-b": "hello world",
    });
  });

  // [leo] LeoPhoneAgent 不做任何遥测：prepareModelTelemetryEnv 原样返回 env，不生成 installation id，
  // 也不读写 telemetry-state.json。
  it("即使配置了 OTLP endpoint 也不生成 installation id、不写 telemetry-state.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-telemetry-"));
    const env = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:1/v1/traces",
      ZCODE_HOME: home,
    };
    const prepared = await prepareModelTelemetryEnv(env, {
      cliVersion: "0.16.1",
      productVersion: "3.6.1",
    });

    expect(prepared).toEqual(env);
    expect(prepared.ZCODE_TELEMETRY_DEVICE_MID).toBeUndefined();
    await expect(readFile(join(home, "v2", "telemetry-state.json"), "utf8")).rejects.toThrow();
  });
});
