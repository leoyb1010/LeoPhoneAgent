import { describe, expect, it } from "vitest";
import { isServerPrivateEnvKey, stripServerPrivateEnv } from "./server-private-env.js";
import { runChildProcess } from "./server-utils.js";

// 发行层 1.1.6：私密变量剔除的单元与真实子进程回归。
const server = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/service",
  LANG: "zh_CN.UTF-8",
  HTTPS_PROXY: "http://127.0.0.1:7890",
  NO_PROXY: "localhost,127.0.0.1",
  CODEX_HOME: "/home/service/.codex",
  CLAUDE_CONFIG_DIR: "/home/service/.claude",
  GROK_HOME: "/home/service/.grok",
  OPENAI_API_KEY: "provider-key-kept-for-cli",
  DATABASE_URL: "postgres://fixture:db-secret@127.0.0.1/paperclip",
  DATABASE_MIGRATION_URL: "postgres://fixture:migration-secret@127.0.0.1/paperclip",
  BETTER_AUTH_SECRET: "auth-secret",
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "signing-secret",
  PAPERCLIP_SECRETS_MASTER_KEY: "master-key",
  PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/secure/master.key",
  PAPERCLIP_AGENT_JWT_SECRET: "jwt-secret",
  PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "connector-private",
  PAPERCLIP_TEST_DATABASE_URL: "postgres://test-secret",
  PGPASSWORD: "pg-secret",
  PGHOST: "127.0.0.1",
  PGUSER: "leophone",
  PGPASSFILE: "/secure/.pgpass",
  PAPERCLIP_PUBLIC_URL: "https://example.invalid",
  PAPERCLIP_NATIVE_CLI_LOGIN_ENABLED: "true",
};

describe("server private environment stripping", () => {
  it("classifies server credentials, database and libpq variables as private", () => {
    for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "BETTER_AUTH_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_MASTER_KEY", "PAPERCLIP_API_KEY",
      "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_TEST_DATABASE_URL", "PGPASSWORD", "PGHOST", "PGPASSFILE", "PGSSLKEY"]) {
      expect(isServerPrivateEnvKey(key), key).toBe(true);
    }
    for (const key of ["PATH", "HOME", "LANG", "HTTPS_PROXY", "NO_PROXY", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME",
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PAPERCLIP_PUBLIC_URL", "PAPERCLIP_RUNTIME_API_URL", "XDG_CACHE_HOME", "TMPDIR"]) {
      expect(isServerPrivateEnvKey(key), key).toBe(false);
    }
  });

  it("removes every inherited private value and keeps CLI configuration, proxies and locale", () => {
    const result = stripServerPrivateEnv(server, server);
    for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "BETTER_AUTH_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_AGENT_JWT_SECRET",
      "PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", "PAPERCLIP_TEST_DATABASE_URL", "PGPASSWORD", "PGHOST", "PGUSER", "PGPASSFILE"]) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result).toMatchObject({ PATH: server.PATH, HOME: server.HOME, LANG: server.LANG, HTTPS_PROXY: server.HTTPS_PROXY,
      NO_PROXY: server.NO_PROXY, CODEX_HOME: server.CODEX_HOME, CLAUDE_CONFIG_DIR: server.CLAUDE_CONFIG_DIR,
      GROK_HOME: server.GROK_HOME, OPENAI_API_KEY: server.OPENAI_API_KEY, PAPERCLIP_PUBLIC_URL: server.PAPERCLIP_PUBLIC_URL });
    expect(server.DATABASE_URL).toContain("db-secret");
  });

  it("keeps an explicitly configured value that differs from the server's own value", () => {
    const result = stripServerPrivateEnv({ ...server, PAPERCLIP_API_KEY: "per-run-agent-key", DATABASE_URL: "postgres://agent-project-db" }, server);
    expect(result.PAPERCLIP_API_KEY).toBe("per-run-agent-key");
    expect(result.DATABASE_URL).toBe("postgres://agent-project-db");
    expect(result).not.toHaveProperty("BETTER_AUTH_SECRET");
  });

  it("does not hand inherited server secrets to a real agent child process", async () => {
    const keys = ["DATABASE_URL", "BETTER_AUTH_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "PGPASSWORD", "PAPERCLIP_SECRETS_MASTER_KEY"];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { DATABASE_URL: "postgres://inherited-db-secret", BETTER_AUTH_SECRET: "inherited-auth-secret",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "inherited-signing-secret", PGPASSWORD: "inherited-pg-secret", PAPERCLIP_SECRETS_MASTER_KEY: "inherited-master" });
    try {
      // 模拟 Hermes 等适配器把 { ...process.env, ...config.env } 整体作为 opts.env 传入。
      const result = await runChildProcess("private-env-fixture", process.execPath,
        ["-e", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]).concat([["PAPERCLIP_API_KEY", process.env.PAPERCLIP_API_KEY ?? null], ["LANG", process.env.LANG ?? null]]))))`],
        { cwd: process.cwd(), env: { ...process.env, PAPERCLIP_API_KEY: "per-run-agent-key", LANG: "zh_CN.UTF-8" } as Record<string, string>,
          timeoutSec: 20, graceSec: 1, onLog: async () => {} });
      expect(result.exitCode).toBe(0);
      const seen = JSON.parse(result.stdout);
      for (const key of keys) expect(seen[key], key).toBeNull();
      expect(seen.PAPERCLIP_API_KEY).toBe("per-run-agent-key");
      expect(seen.LANG).toBe("zh_CN.UTF-8");
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});
