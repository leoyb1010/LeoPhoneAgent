import { beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const mocks = vi.hoisted(() => ({
  access: { isInstanceAdmin: vi.fn(), canUser: vi.fn(), decide: vi.fn() },
  environments: { getById: vi.fn(), listBoundCompanyIds: vi.fn() },
  resolve: vi.fn(), factory: vi.fn(),
  native: { device: { acquireLoginLease: vi.fn() }, setupToken: { acquire: vi.fn() }, releaseById: vi.fn(), reapExpired: vi.fn(), shutdown: vi.fn() },
}));
vi.mock("../services/access.js", () => ({ accessService: () => mocks.access }));
vi.mock("../services/environments.js", () => ({ environmentService: () => mocks.environments }));
vi.mock("../services/host-cli-auth-status.js", () => ({ resolveHostCliExecutable: mocks.resolve }));
vi.mock("../services/native-provider-login.js", () => ({ createNativeProviderLoginRuntime: mocks.factory }));
import { createNativeLoginController } from "../services/native-login-controller.js";
const intent = { provider: "openai", method: "subscription", name: "Owner", ownership: "personal", agentIds: [], allAgents: true } as const;
const req = { actor: { type: "board", userId: "owner", source: "session", isInstanceAdmin: true, companyIds: ["company"] } } as any;
const row = { aiConnection: intent };
const db = { select: () => ({ from: () => ({ where: async () => [row] }) }) } as any;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.isInstanceAdmin.mockResolvedValue(true); mocks.access.canUser.mockResolvedValue(true); mocks.access.decide.mockResolvedValue({ allowed: true });
  mocks.environments.getById.mockResolvedValue({ id: "local", driver: "local", status: "active" });
  mocks.environments.listBoundCompanyIds.mockResolvedValue(["company"]);
  mocks.resolve.mockImplementation(async (adapter: string) => `/trusted/bin/${adapter.replace('_local', '')}`);
  mocks.factory.mockReturnValue(mocks.native);
  mocks.native.device.acquireLoginLease.mockResolvedValue({ providerLeaseId: "11111111-1111-4111-8111-111111111111" });
  mocks.native.setupToken.acquire.mockResolvedValue({ leaseId: "11111111-1111-4111-8111-111111111111" });
});
const env = { PAPERCLIP_HOME: "/physical", PAPERCLIP_NATIVE_CLI_LOGIN_ENABLED: "true" };
test("default feature is disabled before acquisition", async () => {
  const controller = createNativeLoginController(db, { PAPERCLIP_HOME: "/physical" });
  await expect(controller.assertRequest(req, "company", "local", "codex_local", intent as any)).rejects.toThrow();
  expect(mocks.factory).not.toHaveBeenCalled();
});
test("native login requires admin, a stable owner and agents:create", async () => {
  const controller = createNativeLoginController(db, env);
  await expect(controller.assertRequest({ actor: { ...req.actor, isInstanceAdmin: false } } as any, "company", "local", "codex_local", intent as any)).rejects.toThrow();
  await expect(controller.assertRequest({ actor: { ...req.actor, userId: undefined } } as any, "company", "local", "codex_local", intent as any)).rejects.toThrow();
  mocks.access.decide.mockResolvedValue({ allowed: false });
  await expect(controller.assertRequest(req, "company", "local", "codex_local", intent as any)).rejects.toThrow();
  expect(mocks.factory).not.toHaveBeenCalled();
});
test("foreign environment and missing connection intent fail before any PTY", async () => {
  const controller = createNativeLoginController(db, env);
  await expect(controller.assertRequest(req, "company", "local", "codex_local")).rejects.toThrow(/explicit subscription/);
  mocks.environments.listBoundCompanyIds.mockResolvedValue(["foreign"]);
  await expect(controller.assertRequest(req, "company", "local", "codex_local", intent as any)).rejects.toThrow(/another company/);
  expect(mocks.factory).not.toHaveBeenCalled();
});
test("native rechecks persisted admin/create permissions", async () => {
  const controller = createNativeLoginController(db, env);
  mocks.access.isInstanceAdmin.mockResolvedValue(false);
  await expect(controller.assertRequest(req, "company", "local", "codex_local", intent as any)).rejects.toThrow();
  mocks.access.isInstanceAdmin.mockResolvedValue(true); mocks.access.canUser.mockResolvedValue(false);
  await expect(controller.assertRequest(req, "company", "local", "codex_local", intent as any)).rejects.toThrow();
});
test("sandbox device and setup-token paths retain their original runtime", async () => {
  mocks.environments.getById.mockResolvedValue({ driver: "sandbox" });
  const controller = createNativeLoginController(db, env);
  const device = { acquireLoginLease: vi.fn(async () => ({ providerLeaseId: "sandbox" })) };
  const setup = { acquire: vi.fn(async () => ({ leaseId: "sandbox" })), release: vi.fn() };
  const input = { companyId: "company", environmentId: "sandbox", startedByUserId: "owner", adapterType: "codex_local", sessionId: "session" } as any;
  expect(await controller.deviceRuntime(device as any).acquireLoginLease(input)).toEqual({ providerLeaseId: "sandbox" });
  expect(await controller.setupTokenProvider(setup as any).acquire({ scope: { companyId: "company", environmentId: "sandbox" } } as any)).toEqual({ leaseId: "sandbox" });
  expect(mocks.factory).not.toHaveBeenCalled();
});
test("native factory receives fixed resolved absolute executables, not request commands", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-controller-")));
  const instance = path.join(base, "instances", "default"); await mkdir(instance, { recursive: true });
  try {
    const controller = createNativeLoginController(db, { ...env, PAPERCLIP_HOME: base });
    const input = { companyId: "company", environmentId: "local", startedByUserId: "owner", adapterType: "codex_local", sessionId: "11111111-1111-4111-8111-111111111111", command: "/malicious" } as any;
    await controller.deviceRuntime({ acquireLoginLease: vi.fn() } as any).acquireLoginLease(input);
    expect(mocks.factory).toHaveBeenCalledWith(expect.objectContaining({ binaries: { codex: "/trusted/bin/codex", grok: "/trusted/bin/grok", claude: "/trusted/bin/claude" } }));
    expect(mocks.native.device.acquireLoginLease).toHaveBeenCalledWith(input);
    expect(await controller.releaseNativeLease("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(mocks.native.releaseById).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    await controller.shutdown();
  } finally { await rm(base, { recursive: true, force: true }); }
});
