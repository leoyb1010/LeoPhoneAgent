import { describe, expect, it } from "vitest";
import { sanitizeRuntimeServiceBaseEnv } from "../services/workspace-runtime.js";

// 发行层 1.1.6：工作区运行服务的基础环境同样剔除服务器私密变量。
describe("runtime service base environment", () => {
  it("drops server secrets beyond the upstream PAPERCLIP_/DATABASE_URL list and keeps tooling variables", () => {
    const env = sanitizeRuntimeServiceBaseEnv({
      PATH: "/usr/bin:/bin", HOME: "/home/service", HTTPS_PROXY: "http://127.0.0.1:7890",
      BETTER_AUTH_SECRET: "auth-secret", DATABASE_URL: "postgres://db", DATABASE_MIGRATION_URL: "postgres://migrate",
      PGPASSWORD: "pg-secret", PGHOST: "127.0.0.1", PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "signing",
    });
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/service", HTTPS_PROXY: "http://127.0.0.1:7890" });
  });
});
