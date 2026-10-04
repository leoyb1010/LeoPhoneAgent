// @vitest-environment jsdom

import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Environment, UserSecretDefinition } from "@paperclipai/shared";
import { getEnvironmentCapabilities } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import { AgentConfigForm, AdapterLoginPanel, subtractPersistedOverlay, type AdapterLoginDescriptor } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";
import { buildNewAgentHirePayload } from "../lib/new-agent-hire-payload";
import { ApiError } from "../api/client";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
  startAdapterAuthLogin: vi.fn(),
  getAdapterAuthLoginStatus: vi.fn(),
  getActiveAdapterAuthLoginSession: vi.fn(),
  cancelAdapterAuthLogin: vi.fn(),
  startClaudeSetupTokenLogin: vi.fn(),
  getClaudeSetupTokenLoginStatus: vi.fn(),
  getActiveClaudeSetupTokenLoginSession: vi.fn(),
  getClaudeSetupTokenLoginPrompt: vi.fn(),
  submitClaudeSetupTokenBrowserCode: vi.fn(),
  completeClaudeSetupTokenLogin: vi.fn(),
  cancelClaudeSetupTokenLogin: vi.fn(),
  getClaudeOAuthTokenStatus: vi.fn(),
}));

// The default resume read for a test that does not exercise resume: no active
// session for the caller.
function noActiveSession() {
  return Promise.reject(
    new ApiError("Adapter login session not found", 404, { error: "Adapter login session not found" }),
  );
}

const mockClipboard = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listProposals: vi.fn(),
  listUserSecretDefinitions: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../lib/clipboard", () => ({
  copyTextToClipboard: mockClipboard.copyTextToClipboard,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    selectionSource: "bootstrap",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("../adapters", () => ({
  getUIAdapter: (type: string) => ({
    type,
    label: type === "hermes_gateway" ? "Hermes Gateway" : "Codex",
    // The stand-in also records the two gates the form resolves for every
    // adapter, so a test can assert the plumbing without rendering a real
    // adapter's fields.
    ConfigFields: ({ adapterType, hideInstructionsFile, managedSandboxOnly }: {
      adapterType: string;
      hideInstructionsFile?: boolean;
      managedSandboxOnly?: boolean;
    }) =>
      adapterType === "hermes_gateway"
        ? <div data-testid="hermes-gateway-config-fields">Hermes Gateway fields</div>
        : (
          <div
            data-testid="adapter-config-fields"
            data-hide-instructions-file={String(hideInstructionsFile === true)}
            data-managed-sandbox-only={String(managedSandboxOnly === true)}
          />
        ),
    buildAdapterConfig: (values: { model?: string }) => ({
      model: values.model || undefined,
    }),
    parseStdoutLine: () => [],
  }),
}));

// The projected login capability per adapter type. The server projects these
// safe scalar fields. `codex_local` drives the displayed-code panel; `claude_local`
// drives the submitted-browser-code panel. A test overrides this map to add a
// third adapter with a projected login capability.
const mockLoginProjections = vi.hoisted(
  () =>
    new Map<string, { panelMode: string; timeoutPolicy: string }>([
      ["codex_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      ["grok_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      ["claude_local", { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" }],
      // A third adapter, not a built-in, with a projected displayed-code login.
      ["vendor_local", { panelMode: "displayed_code", timeoutPolicy: "caller_bounded" }],
      // A non-built-in adapter with a submitted-browser-code login. Every login
      // runs on a real pseudo-terminal, so the gate requires the provider pty
      // capability from the login capability, not the adapter name.
      ["pty_vendor_local", { panelMode: "submitted_browser_code", timeoutPolicy: "fixed" }],
    ]),
);

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (adapterType: string) => {
    const login = mockLoginProjections.get(adapterType);
    return adapterType === "hermes_gateway"
      ? {
          supportsInstructionsBundle: false,
          supportsSkills: false,
          supportsLocalAgentJwt: false,
          requiresMaterializedRuntimeSkills: false,
          supportsAcp: false,
        }
      : {
          supportsInstructionsBundle: true,
          supportsSkills: true,
          supportsLocalAgentJwt: true,
          requiresMaterializedRuntimeSkills: false,
          supportsAcp: true,
          ...(login ? { login } : {}),
        };
  },
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => [],
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Markdown"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Cody",
    role: "Engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Agent;
}

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderForm(
  environments: Environment[],
  agentOverrides: Partial<Agent> = {},
  options: {
    showAdapterTestEnvironmentButton?: boolean;
    content?: "configuration" | "secrets";
    environmentVariablesPlacement?: "configuration" | "secrets";
    hideInlineSave?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    onSaveActionChange?: (save: (() => void) | null) => void;
    onCancelActionChange?: (cancel: (() => void) | null) => void;
  } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TooltipProvider>
            <AgentConfigForm
              mode="edit"
              agent={makeAgent(agentOverrides)}
              onSave={onSave}
              hidePromptTemplate
              content={options.content}
              environmentVariablesPlacement={options.environmentVariablesPlacement}
              hideInlineSave={options.hideInlineSave}
              onDirtyChange={options.onDirtyChange}
              onSaveActionChange={options.onSaveActionChange}
              onCancelActionChange={options.onCancelActionChange}
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
            />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onSave };
}

async function renderCreateForm(
  environments: Environment[],
  valueOverrides: Partial<typeof defaultCreateValues> = {},
  options: { showAdapterTestEnvironmentButton?: boolean } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const values = {
    ...defaultCreateValues,
    adapterType: "codex_local",
    ...valueOverrides,
  };
  const onChange = vi.fn();

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TooltipProvider>
            <AgentConfigForm
              mode="create"
              values={values}
              onChange={onChange}
              hidePromptTemplate
              showAdapterTypeField={false}
              showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
            />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onChange };
}

const AUTH_MISSING_RESULT = {
  adapterType: "codex_local",
  status: "fail",
  checks: [
    {
      code: "adapter_auth_missing",
      level: "error",
      message: "The sandbox has no ready authentication.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

const VENDOR_AUTH_MISSING_RESULT = {
  adapterType: "vendor_local",
  status: "fail",
  checks: [
    {
      code: "adapter_auth_missing",
      level: "error",
      message: "The sandbox has no ready authentication.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

const GROK_AUTH_MISSING_RESULT = {
  adapterType: "grok_local",
  status: "warn",
  checks: [
    {
      code: "grok_hello_probe_auth_required",
      level: "warn",
      message: "Grok CLI could not answer the hello probe because authentication is missing.",
    },
    {
      code: "adapter_auth_missing",
      level: "warn",
      message: "This environment has no ready authentication for this adapter.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

const PTY_VENDOR_AUTH_MISSING_RESULT = {
  adapterType: "pty_vendor_local",
  status: "fail",
  checks: [
    {
      code: "adapter_auth_missing",
      level: "error",
      message: "The sandbox has no ready authentication.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

const CLAUDE_AUTH_MISSING_RESULT = {
  adapterType: "claude_local",
  status: "warn",
  checks: [
    {
      code: "claude_hello_probe_auth_required",
      level: "warn",
      message: "Claude CLI is installed, but login is required.",
    },
    {
      code: "adapter_auth_missing",
      level: "warn",
      message: "The sandbox has no ready authentication for this adapter.",
    },
  ],
  testedAt: new Date(0).toISOString(),
};

// The provider capabilities the form fetches. Daytona advertises the
// setup-token login capability; E2B does not. The Claude login panel shows only
// for a provider with the capability.
const SANDBOX_CAPABILITIES = getEnvironmentCapabilities(["claude_local", "codex_local"], {
  sandboxProviders: {
    daytona: { supportsLoginPty: true, displayName: "Daytona" },
    e2b: { supportsLoginPty: false, displayName: "E2B" },
  },
});

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

function findByAriaLabel(container: HTMLElement, label: string) {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

async function renderCodexSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

// A third adapter, not a built-in, in a sandbox environment. Its projected login
// capability drives the login affordance and the displayed-code panel. The
// provider advertises the login pseudo-terminal capability the login needs.
async function renderVendorSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "vendor_local", defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

// A Grok agent in a sandbox environment. Its projected login capability
// drives the login affordance and the displayed-code panel, the same as
// Codex. The provider advertises the login pseudo-terminal capability the
// login needs.
async function renderGrokSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "grok_local", defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

async function renderClaudeSandbox(agentOverrides: Partial<Agent> = {}) {
  return renderForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "claude_local", defaultEnvironmentId: "sandbox-1", ...agentOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

async function renderCreateClaudeSandbox(
  valueOverrides: Partial<typeof defaultCreateValues> = {},
) {
  return renderCreateForm(
    [
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "Daytona",
        driver: "sandbox",
        config: { provider: "daytona" },
      }),
    ],
    { adapterType: "claude_local", defaultEnvironmentId: "sandbox-1", ...valueOverrides },
    { showAdapterTestEnvironmentButton: true },
  );
}

// A create-mode harness that holds the form values in React state. A value
// patch from the form (a login claim, an environment change) updates the props,
// so the form re-runs its effects against the new state. The fixed-values
// `renderCreateForm` harness cannot show the environment-change reset, because
// its `values` prop never changes. `valuesRef` exposes the current merged
// values to the test.
async function renderStatefulCreateClaudeSandbox(environments: Environment[]) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const valuesRef: { current: typeof defaultCreateValues } = {
    current: {
      ...defaultCreateValues,
      adapterType: "claude_local",
      defaultEnvironmentId: "sandbox-1",
    },
  };

  function Harness() {
    const [values, setValues] = useState(valuesRef.current);
    valuesRef.current = values;
    return (
      <AgentConfigForm
        mode="create"
        values={values}
        onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))}
        hidePromptTemplate
        showAdapterTypeField={false}
        showAdapterTestEnvironmentButton
      />
    );
  }

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, valuesRef };
}

async function selectEnvironment(container: HTMLElement, environmentId: string) {
  const select = container.querySelector("select");
  await act(async () => {
    if (select) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, environmentId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await flushReact();
}

async function clickByText(container: HTMLElement, label: string) {
  const button = findButton(container, label);
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function clickElement(element: Element | null | undefined) {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function runTest(container: HTMLElement) {
  await clickByText(container, "Test");
}

async function startLogin(container: HTMLElement) {
  await clickByText(container, "Sign in");
  await flushReact();
}

// Flush React effects and pending promises until a condition holds. The Claude
// login chains a start, a status poll, and a completion read, so a single flush
// does not settle every state transition.
async function flushUntil(check: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) break;
    await flushReact();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await flushReact();
}


vi.mock("@/api/health", () => ({ healthApi: { get: vi.fn(async () => ({ nativeAdapterLoginSupported: true })) } }));
vi.mock("./ai-connections/AiConnectionField", () => ({ AiConnectionField: () => <div /> }));
describe("onboarding adapter browser auth failure retry", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    });
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockEnvironmentsApi.capabilities.mockResolvedValue(SANDBOX_CAPABILITIES);
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.listProposals.mockResolvedValue([]);
    // Default: the caller has no active session. A resume test overrides this
    // with a resolved session body.
    mockAgentsApi.getActiveAdapterAuthLoginSession.mockImplementation(noActiveSession);
    mockAgentsApi.getActiveClaudeSetupTokenLoginSession.mockImplementation(noActiveSession);
    mockAgentsApi.startAdapterAuthLogin.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "waiting_for_user",
      expiresAt: null,
      failure: null,
      prompt: { url: "https://auth.example.test/device", code: "WXYZ-1234" },
    });
    mockAgentsApi.cancelAdapterAuthLogin.mockResolvedValue({
      sessionId: "session-1",
      environmentId: "sandbox-1",
      status: "cancelled",
      expiresAt: null,
      failure: null,
      prompt: null,
    });
    mockClipboard.copyTextToClipboard.mockResolvedValue(undefined);
    mockAgentsApi.startClaudeSetupTokenLogin.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "starting",
      expiresAt: null,
      failure: null,
      panelMode: "submitted_browser_code",
      prompt: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "waiting_for_user",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.getClaudeSetupTokenLoginPrompt.mockResolvedValue({
      authorizationUrl: "https://claude.example.test/authorize",
    });
    mockAgentsApi.submitClaudeSetupTokenBrowserCode.mockResolvedValue({
      sessionId: "claude-session-1",
      environmentId: "sandbox-1",
      status: "authenticated",
      expiresAt: null,
      failure: null,
    });
    mockAgentsApi.completeClaudeSetupTokenLogin.mockResolvedValue({
      storedSessionId: "stored-session-1",
    });
    mockAgentsApi.cancelClaudeSetupTokenLogin.mockResolvedValue(undefined);
    // Default: the owner has no stored Claude login. A test that needs a stored
    // value overrides this with a status body.
    mockAgentsApi.getClaudeOAuthTokenStatus.mockResolvedValue(null);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });


  async function renderPanel(adapterType: string) {
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container); roots.push(root);
    const connected = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={queryClient}><TooltipProvider><AdapterLoginPanel companyId="company-1" adapterType={adapterType} environmentId="native-local" chrome="onboarding" autoStart aiConnection={{ provider: adapterType === "claude_local" ? "anthropic" : adapterType === "grok_local" ? "xai" : "openai", method: "subscription", name: "Fixture account", ownership: "personal", agentIds: [], allAgents: true }} onConnected={connected} onStored={() => {}} /></TooltipProvider></QueryClientProvider>));
    await flushReact(); return { container, connected };
  }
  it.each(["grok_local", "codex_local"])("restarts %s failed authorization without navigating away", async adapterType => {
    mockAgentsApi.startAdapterAuthLogin.mockResolvedValueOnce({ sessionId: "failed-session", environmentId: "native-local", status: "starting" }).mockResolvedValueOnce({ sessionId: "fresh-session", environmentId: "native-local", status: "starting" });
    mockAgentsApi.getAdapterAuthLoginStatus.mockImplementation(async (_company, _adapter, id) => id === "failed-session" ? { sessionId: id, status: "failed", failure: { code: "login_command_failed", message: "fixed non-secret failure" }, prompt: null } : { sessionId: id, status: "waiting_for_user", prompt: { url: "https://auth.example.test/device", code: "TEST-1234" } });
    const result = await renderPanel(adapterType);
    await vi.waitFor(() => expect(result.container.textContent).toContain("重新开始授权"));
    expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
    const retry = [...result.container.querySelectorAll("button")].find(b => b.textContent?.includes("重新开始授权"))!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(2));
    expect(mockAgentsApi.cancelAdapterAuthLogin).toHaveBeenCalledWith("company-1", adapterType, "failed-session");
    await vi.waitFor(() => expect(result.container.textContent).toContain("TEST-1234"));
    expect(result.container.textContent).not.toContain("重新开始授权");
    expect(result.connected).not.toHaveBeenCalled();
    expect(mockAgentsApi.startAdapterAuthLogin.mock.calls[1]).toEqual(mockAgentsApi.startAdapterAuthLogin.mock.calls[0]);
  });
  it.each(["timed_out", "cancelled"])("offers restart for displayed-code terminal %s", async status => {
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({ sessionId: "session-1", status, prompt: null });
    const result = await renderPanel("grok_local");
    await vi.waitFor(() => expect(result.container.textContent).toContain("重新开始授权"));
  });
  it("does not offer restart or duplicate start while a displayed-code session is preparing", async () => {
    mockAgentsApi.getAdapterAuthLoginStatus.mockResolvedValue({ sessionId: "session-1", status: "starting", prompt: null });
    const result = await renderPanel("grok_local");
    await vi.waitFor(() => expect(mockAgentsApi.getAdapterAuthLoginStatus).toHaveBeenCalled());
    expect(result.container.textContent).not.toContain("重新开始授权");
    expect(mockAgentsApi.startAdapterAuthLogin).toHaveBeenCalledTimes(1);
  });
  it("restarts Claude submitted-code authorization using the same captured intent", async () => {
    mockAgentsApi.startClaudeSetupTokenLogin.mockResolvedValueOnce({ sessionId: "failed-claude", environmentId: "native-local", status: "starting" }).mockResolvedValueOnce({ sessionId: "fresh-claude", environmentId: "native-local", status: "starting" });
    mockAgentsApi.getClaudeSetupTokenLoginStatus.mockImplementation(async (_company, id) => ({ sessionId: id, status: id === "failed-claude" ? "failed" : "waiting_for_user" }));
    const result = await renderPanel("claude_local");
    await vi.waitFor(() => expect(result.container.textContent).toContain("重新开始授权"));
    const retry = [...result.container.querySelectorAll("button")].find(b => b.textContent?.includes("重新开始授权"))!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(mockAgentsApi.startClaudeSetupTokenLogin).toHaveBeenCalledTimes(2));
    expect(mockAgentsApi.cancelClaudeSetupTokenLogin).toHaveBeenCalledWith("company-1", "failed-claude");
    expect(mockAgentsApi.startClaudeSetupTokenLogin.mock.calls[1]).toEqual(mockAgentsApi.startClaudeSetupTokenLogin.mock.calls[0]);
    await vi.waitFor(() => expect(result.container.textContent).not.toContain("重新开始授权"));
    expect(result.connected).not.toHaveBeenCalled();
  });
});
