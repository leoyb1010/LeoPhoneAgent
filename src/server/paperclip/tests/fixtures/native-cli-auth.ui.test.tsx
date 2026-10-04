// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProviderConnection } from "./AgentProviderConnection";
import { defaultAiConnectionName } from "../ai-connections/model";
import { ApiError } from "@/api/client";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  login: vi.fn(),
  personal: vi.fn(),
  organization: vi.fn(),
  loginPanel: vi.fn(),
}));
const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] })),
  loginResult: vi.fn(async () => ({ connectionId: "login-account", grantId: "login-grant" })),
  connectLocal: vi.fn(async () => ({ connectionId: "local-account", grantId: "local-grant" })),
  startLocalLogin: vi.fn(async () => ({ sessionId: "local-attempt", command: "CODEX_HOME='/fixture/isolated-login' codex login", expiresAt: "2026-09-11T20:00:00Z" })),
  checkLocalLogin: vi.fn(async () => ({ status: "sign_in_required" as const })),
  cancelLocalLogin: vi.fn(async () => ({})),
  create: vi.fn(async () => ({ connectionId: "managed-connection", grantId: "managed-grant" })),
  setDefault: vi.fn(async () => ({})),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
vi.mock("@/api/agents", () => ({
  agentsApi: {
    getAdapterAuthSignal: mocks.auth,
    getClaudeOAuthTokenStatus: mocks.login,
  },
}));
vi.mock("@/api/secrets", () => ({
  secretsApi: { listMyUserSecrets: mocks.personal, list: mocks.organization },
}));
vi.mock("../AgentConfigForm", () => ({
  AdapterLoginPanel: (props: unknown) => { mocks.loginPanel(props); return <div>New subscription login</div>; },
}));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(() => {
  flushSync(() => root?.unmount());
  host?.remove();
  client?.clear();
  vi.resetAllMocks();
});
async function mount(
  adapterType: "claude_local" | "codex_local" | "grok_local" = "claude_local",
  savedLogin = false,
  canLogin = true,
  codexSubscriptions = false,
  savedApiKeys = true,
  cachedClaudeLogin = false,
  managedAccount?: Parameters<typeof AgentProviderConnection>[0]["managedAccount"],
  localEnvironment = false,
  deploymentMode: "local_trusted" | "authenticated" = "local_trusted",
  localAiLoginSupported = true,
  nativeAdapterLoginSupported = false,
  authSignal: { status: "present" | "absent" | "unknown"; installed?: boolean; message?: string } = { status: "present", installed: true },
) {
  const key =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  mocks.auth.mockResolvedValue({
    ...authSignal,
  });
  mocks.login.mockImplementation(async () => {
    if (savedLogin) return { secretId: "oauth", latestVersion: 1 };
    throw new ApiError("Not found", 404, null);
  });
  mocks.personal.mockResolvedValue([
    {
      definition: {
        id: "d1",
        companyId: "c1",
        key: `${key}.setup.1`,
        name: "Personal key",
        status: "active",
      },
      secret: { companyId: "c1", status: "active" },
    },
  ]);
  mocks.organization.mockResolvedValue([
    {
      id: "s1",
      companyId: "c1",
      key,
      name: "Company key",
      scope: "company",
      status: "active",
    },
    ...(codexSubscriptions
      ? [
          {
            id: "codex-home",
            companyId: "c1",
            name: "CODEX_HOME_team",
            scope: "company",
            status: "active",
          },
        ]
      : []),
  ]);
  if (!savedApiKeys) {
    mocks.personal.mockResolvedValue([]);
    mocks.organization.mockResolvedValue([]);
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedClaudeLogin) {
    client.setQueryData(["claude-oauth-token-status", "c1"], { secretId: "cached-claude", latestVersion: 1 });
    mocks.auth.mockResolvedValue({ status: "absent" });
  }
  client.setQueryData(["health"], { deploymentMode, localAiLoginSupported, nativeAdapterLoginSupported });
  client.setQueryDefaults(["health"], { staleTime: Infinity });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const test = vi.fn().mockResolvedValue(true);
  const connected = vi.fn();
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <AgentProviderConnection
          companyId="c1"
          adapterType={adapterType}
          environmentId="e1"
          canLogin={canLogin}
          localEnvironment={localEnvironment}
          onBack={() => {}}
          testConnection={test}
          onConnected={connected}
          managedAccount={managedAccount}
        />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(mocks.personal).toHaveBeenCalled());
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  if (savedApiKeys && !managedAccount) await vi.waitFor(() => expect(host.textContent).toContain("2 saved API keys"));
  return { test, connected, key };
}
function click(text: string) {
  const translated = text === "Connect" ? "连接" : text === "Back" ? "返回" : text.replace("Sign in to", "登录");
  const button = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text) || b.textContent?.includes(translated),
  )!;
  expect(button).toBeTruthy();
  flushSync(() => button.click());
}
function openProvider() {
  flushSync(() =>
    (host.querySelector('[role="radio"]') as HTMLElement).click(),
  );
}
describe("native CLI browser auth capability", () => {
  it.each(["claude_local", "codex_local", "grok_local"] as const)("reuses %s server CLI auth without creating or importing an account", async adapter => {
    const { test, connected } = await mount(adapter, false, true, false, false, false, undefined, true, "authenticated", false, true);
    openProvider();
    expect(host.textContent).toContain("已读取服务器 CLI 登录");
    expect(host.textContent).not.toMatch(/does not support browser sign-in|此环境不支持浏览器登录/);
    expect(mocks.loginPanel).not.toHaveBeenCalled();
    click("Connect");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ env: {} }));
    expect(test).toHaveBeenCalledWith({ env: {} });
    expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
    expect(managedApi.create).not.toHaveBeenCalled();
    expect(managedApi.setDefault).not.toHaveBeenCalled();
  });
  it.each(["claude_local", "codex_local", "grok_local"] as const)("reauthorizes %s through its upstream browser panel and waits for explicit adoption", async adapter => {
    const { connected } = await mount(adapter, false, true, false, false, false, undefined, true, "authenticated", false, true);
    openProvider(); click("重新授权服务器 CLI");
    const panel = () => mocks.loginPanel.mock.calls.at(-1)![0];
    expect(panel().adapterType).toBe(adapter);
    expect(panel().aiConnection).toMatchObject({ method: "subscription", ownership: "personal" });
    expect(panel().autoStart).toBe(true);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    flushSync(() => panel().onPromptReady("https://provider.example/authorize"));
    click(adapter === "claude_local" ? "Sign in to Claude" : adapter === "grok_local" ? "Sign in to Grok" : "Sign in to OpenAI");
    expect(open).toHaveBeenCalledWith("https://provider.example/authorize", "_blank", "noreferrer,noopener");
    flushSync(() => panel().onConnected("session-native"));
    await vi.waitFor(() => expect(host.textContent).toContain("新授权已就绪"));
    expect(managedApi.loginResult).toHaveBeenCalledWith("c1", "session-native");
    expect(managedApi.setDefault).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    click("使用新授权");
    await vi.waitFor(() => expect(connected).toHaveBeenCalledWith({ env: {}, aiConnection: { provider: adapter === "claude_local" ? "anthropic" : adapter === "grok_local" ? "xai" : "openai", method: "subscription", mode: "responsible_user" } }));
    expect(managedApi.setDefault).toHaveBeenCalledWith("c1", "login-grant");
    open.mockRestore();
  });
  it("abandons a newly authenticated account without changing any default when navigating back", async () => {
    const { connected } = await mount("codex_local", false, true, false, false, false, undefined, true, "authenticated", false, true);
    openProvider(); click("重新授权服务器 CLI");
    flushSync(() => mocks.loginPanel.mock.calls.at(-1)![0].onConnected("session-native"));
    await vi.waitFor(() => expect(host.textContent).toContain("新授权已就绪"));
    click("Back");
    expect(managedApi.setDefault).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
  });
  it("reports a missing CLI with the server diagnostic and does not start login or connect", async () => {
    const { connected, test } = await mount("codex_local", false, true, false, false, false, undefined, true, "authenticated", false, true, { status: "absent", installed: false, message: "Codex CLI was not found on this host" });
    openProvider();
    expect(host.textContent).toContain("Codex CLI was not found on this host");
    click("Connect");
    expect(test).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
    expect(mocks.loginPanel).not.toHaveBeenCalled();
  });
  it("starts absent native auth in the browser rather than showing a terminal command", async () => {
    await mount("grok_local", false, true, false, false, false, undefined, true, "authenticated", false, true, { status: "absent", installed: true });
    openProvider();
    expect(mocks.loginPanel.mock.calls.at(-1)![0]).toMatchObject({ adapterType: "grok_local", environmentId: "e1" });
    expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/does not support browser sign-in|此环境不支持浏览器登录/);
  });
  it("does not infer native browser login on a public instance with no explicit capability", async () => {
    await mount("codex_local", false, false, false, false, false, undefined, true, "authenticated", false, false, { status: "absent", installed: true });
    openProvider();
    expect(host.textContent).toMatch(/does not support browser sign-in|此环境不支持浏览器登录/);
    expect(mocks.loginPanel).not.toHaveBeenCalled();
    expect(managedApi.startLocalLogin).not.toHaveBeenCalled();
  });
  it("keeps managed reconnect intent instead of silently reusing the shared server CLI", async () => {
    const onComplete = vi.fn();
    const intent = { provider: "openai" as const, method: "subscription" as const, name: "Reauthorize personal account", ownership: "personal" as const, agentIds: ["a1"], allAgents: false, connectionId: "existing-account" };
    await mount("codex_local", false, true, false, false, false, { intent, onComplete }, true, "authenticated", false, true);
    openProvider();
    expect(mocks.loginPanel.mock.calls.at(-1)![0].aiConnection).toEqual(intent);
    expect(host.textContent).not.toContain("已读取服务器 CLI 登录");
    flushSync(() => mocks.loginPanel.mock.calls.at(-1)![0].onConnected("session-native"));
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith({ connectionId: "login-account", grantId: "login-grant", method: "subscription" }));
    expect(managedApi.setDefault).not.toHaveBeenCalled();
  });
});
