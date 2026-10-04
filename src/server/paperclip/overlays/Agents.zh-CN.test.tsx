// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { Agents } from "./Agents";
import { Agents as ProductionAgents } from "./Agents.production";

const mockRouterState = vi.hoisted(() => ({
  pathname: "/agents/all",
  navigate: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  org: vi.fn(),
}));

const mockBuiltInAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  provision: vi.fn(),
  reset: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(), getExperimental: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateAgent: vi.fn(),
}));

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({ isMobile: false }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: mockRouterState.pathname, search: "", hash: "", state: null }),
  useNavigate: () => mockRouterState.navigate,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewAgent: mockOpenNewAgent }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: mockSidebarState.isMobile }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/builtInAgents", () => ({
  builtInAgentsApi: mockBuiltInAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: mockResourceMembershipsApi,
}));

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterLabel: (type: string) => type,
}));


import boardFixture from "../i18n/smoke-board-fixture.json";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
const roots: Array<{ root: ReturnType<typeof createRoot>; client: QueryClient; host: HTMLDivElement }> = [];
beforeEach(() => {
  mockAgentsApi.list.mockResolvedValue([]); mockAgentsApi.org.mockResolvedValue([]);
  mockBuiltInAgentsApi.list.mockResolvedValue([]); mockEnvironmentsApi.list.mockResolvedValue([]);
  mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  mockResourceMembershipsApi.listMine.mockResolvedValue(boardFixture.memberships);
  mockInstanceSettingsApi.get.mockResolvedValue(boardFixture.instanceSettings);
  mockInstanceSettingsApi.getExperimental.mockResolvedValue(boardFixture.instanceSettings.experimental);
});
afterEach(() => { for (const { root, client, host } of roots.splice(0)) { flushSync(() => root.unmount()); client.clear(); host.remove(); } vi.clearAllMocks(); });
describe("Chinese agents page with the actual browser API fixture", () => {
  it.each([["streamlined", Agents], ["production", ProductionAgents]] as const)("renders healthy %s empty state and responds to create", async (_mode, Page) => {
    const host = document.createElement("div"); document.body.append(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const root = createRoot(host); roots.push({ root, client, host });
    flushSync(() => root.render(<QueryClientProvider client={client}><ToastProvider><RouteErrorBoundary><Page /></RouteErrorBoundary></ToastProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).toContain("创建第一个智能体，即可开始使用。"));
    expect(host.textContent).not.toContain("此页面发生错误");
    const create = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("新建智能体"));
    expect(create).toBeDefined(); expect(create?.disabled).toBe(false);
    flushSync(() => create!.click()); expect(mockOpenNewAgent).toHaveBeenCalledOnce();
  });
});
