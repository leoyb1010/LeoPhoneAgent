import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import { and, eq, or, sql } from "drizzle-orm";
import { adapterAuthSessions, type Db } from "@paperclipai/db";
import type { AiConnectionLoginIntent, AgentAdapterType } from "@paperclipai/shared";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { forbidden, unprocessable } from "../errors.js";
import { assertCompanyAccess, assertInstanceAdmin } from "../routes/authz.js";
import { assertEnvironmentSelectionForCompany } from "../routes/environment-selection.js";
import { accessService } from "./access.js";
import { environmentService } from "./environments.js";
import { adapterLoginPromotionLockKey, type LoginSessionRuntime } from "./device-login-service.js";
import type { SetupTokenSandboxProvider } from "./setup-token-transport-binding.js";
import { createNativeProviderLoginRuntime, type NativeProviderLoginScope } from "./native-provider-login.js";
import { nativeAdapterLoginSupported } from "./native-cli-login-policy.js";
import { resolveHostCliExecutable } from "./host-cli-auth-status.js";

const NATIVE_TYPES = ["codex_local", "grok_local", "claude_local"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE = ["starting", "waiting_for_user", "promoting", "awaiting_code", "submitting"];
interface NativeLoginController {
  assertRequest(req: Request, companyId: string, environmentId: string, adapterType: string, intent?: AiConnectionLoginIntent): Promise<void>;
  assertScope(scope: NativeProviderLoginScope): Promise<void>;
  deviceRuntime(sandbox: LoginSessionRuntime): LoginSessionRuntime;
  setupTokenProvider(sandbox: SetupTokenSandboxProvider): SetupTokenSandboxProvider;
  releaseNativeLease(id: string): Promise<boolean>;
  startReaper(log: () => void): void;
  shutdown(): Promise<void>;
}
const productionControllers = new WeakMap<Db, NativeLoginController>();

export function assertNativeConnectionIntent(intent: AiConnectionLoginIntent | undefined) {
  if (!intent || intent.method !== "subscription") throw unprocessable("Native sign-in requires an explicit subscription AI connection.");
}

/** Native homes are provider resources, not invented environment_lease rows. */
export function createNativeLoginController(db: Db, env: NodeJS.ProcessEnv = process.env): NativeLoginController {
  const existing = env === process.env ? productionControllers.get(db) : null;
  if (existing) return existing;
  const environments = environmentService(db);
  const access = accessService(db);
  const root = path.join(resolvePaperclipInstanceRootForAdapter({ env, homeDir: env.PAPERCLIP_HOME, instanceId: env.PAPERCLIP_INSTANCE_ID }), "native-provider-login");
  let runtime: ReturnType<typeof createNativeProviderLoginRuntime> | null = null;
  let initializing: Promise<ReturnType<typeof createNativeProviderLoginRuntime>> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping: Promise<void> | null = null;
  const nativeIds = new Set<string>();

  async function assertScope(scope: NativeProviderLoginScope) {
    if (!nativeAdapterLoginSupported(env) || !NATIVE_TYPES.includes(scope.adapterType as typeof NATIVE_TYPES[number])) throw forbidden("Native provider sign-in is disabled.");
    if (!await access.isInstanceAdmin(scope.startedByUserId) || !await access.canUser(scope.companyId, scope.startedByUserId, "agents:create")) throw forbidden("Instance admin and agent creation access are required.");
    const bound = await environments.listBoundCompanyIds(scope.environmentId);
    if (bound.length && !bound.includes(scope.companyId)) throw forbidden("The selected environment belongs to another company.");
    await assertEnvironmentSelectionForCompany(environments, scope.companyId, scope.environmentId, { allowedDrivers: ["local"] });
  }
  // 发行层 1.1.6：CLI 路径按需解析并短缓存 10 秒，不在首次初始化时固定；服务运行期间
  // 新安装或升级的 CLI 可被识别，同时只解析固定 profile 命令和服务器可信 PATH。
  const BINARY_CACHE_TTL_MS = 10_000;
  const binaryCache = new Map<string, { expiresAt: number; value: string }>();
  async function resolveBinary(key: "codex" | "grok" | "claude"): Promise<string> {
    const cached = binaryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await resolveHostCliExecutable(`${key}_local`, env) ?? "";
    binaryCache.set(key, { expiresAt: Date.now() + BINARY_CACHE_TTL_MS, value });
    return value;
  }
  async function getRuntime() {
    if (runtime) return runtime;
    initializing ??= (async () => {
      const parent = path.dirname(root);
      if (await realpath(parent) !== parent) throw forbidden("Native login storage must use its physical path.");
      await mkdir(root, { mode: 0o700 });
    })().catch(async error => {
      // Existing directory is allowed; every acquisition still checks mode/owner.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }).then(async () => {
      runtime = createNativeProviderLoginRuntime({ root, binaries: resolveBinary, env, assertAuthorized: assertScope, onFailure: failure => console.warn("Native CLI login failed:", JSON.stringify(failure)) });
      return runtime;
    });
    try { return await initializing; } catch (error) { initializing = null; throw error; }
  }

  async function isNativeLease(id: string) {
    if (!UUID.test(id)) return false;
    try { return (await stat(path.join(root, id, "lease.json"))).isFile(); } catch { return false; }
  }
  async function releaseNativeLease(id: string): Promise<boolean> {
    if (!nativeIds.has(id) && !await isNativeLease(id)) return false;
    await (await getRuntime()).releaseById(id);
    nativeIds.delete(id);
    return true;
  }

  async function assertRequest(req: Request, companyId: string, environmentId: string, adapterType: string, intent?: AiConnectionLoginIntent) {
    assertInstanceAdmin(req);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({ actor: req.actor, action: "agents:create", resource: { type: "company", companyId } });
    if (!decision.allowed || !req.actor.userId) throw forbidden("Agent creation access and a board user are required.");
    assertNativeConnectionIntent(intent);
    await assertScope({ companyId, environmentId, adapterType, startedByUserId: req.actor.userId });
  }

  function deviceRuntime(sandbox: LoginSessionRuntime): LoginSessionRuntime {
    return { async acquireLoginLease(input) {
      const environment = await environments.getById(input.environmentId);
      if (environment?.driver !== "local") return sandbox.acquireLoginLease(input);
      await assertScope(input);
      const [row] = await db.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.companyId, input.companyId), eq(adapterAuthSessions.startedByUserId, input.startedByUserId),
        eq(adapterAuthSessions.adapterType, input.adapterType),
        or(eq(adapterAuthSessions.id, input.sessionId), eq(adapterAuthSessions.publicSessionId, input.sessionId)),
      ));
      assertNativeConnectionIntent(row?.aiConnection ?? undefined);
      const lease = await (await getRuntime()).device.acquireLoginLease(input);
      nativeIds.add(lease.providerLeaseId);
      return {
        ...lease,
        async deleteSandbox() { const outcome = await lease.deleteSandbox(); nativeIds.delete(lease.providerLeaseId); return outcome; },
        async release() { await lease.release(); nativeIds.delete(lease.providerLeaseId); },
      };
    } };
  }

  function setupTokenProvider(sandbox: SetupTokenSandboxProvider): SetupTokenSandboxProvider {
    return {
      async acquire(input) {
        const environment = await environments.getById(input.scope.environmentId);
        if (environment?.driver !== "local") return sandbox.acquire(input);
        assertNativeConnectionIntent(input.scope.aiConnection);
        await assertScope({ companyId: input.scope.companyId, environmentId: input.scope.environmentId, adapterType: input.scope.adapterType, startedByUserId: input.scope.ownerUserId });
        const lease = await (await getRuntime()).setupToken.acquire(input);
        nativeIds.add(lease.leaseId);
        return lease;
      },
      async release(id) {
        // The private durable resource marker survives a restart. Do not send a
        // native UUID to sandbox.release as if it were an environment lease FK.
        if (!await releaseNativeLease(id)) await sandbox.release(id);
      },
    };
  }

  async function reap() {
    if (!nativeAdapterLoginSupported(env) && !runtime) return;
    const current = await getRuntime();
    await current.reapExpired(async record => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${adapterLoginPromotionLockKey(record.companyId, record.startedByUserId, record.adapterType as AgentAdapterType)}, 0))`);
      const [row] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.providerLeaseId, record.id), eq(adapterAuthSessions.companyId, record.companyId),
        eq(adapterAuthSessions.startedByUserId, record.startedByUserId), eq(adapterAuthSessions.adapterType, record.adapterType as AgentAdapterType),
      )).for("update");
      if (!row) return true;
      const now = new Date();
      if (row.status === "promoting" && row.promotionExpiresAt && row.promotionExpiresAt > now) return false;
      if (ACTIVE.includes(row.status) && row.expiresAt && row.expiresAt > now) return false;
      if (ACTIVE.includes(row.status)) await tx.update(adapterAuthSessions).set({ status: "timed_out", finishedAt: now, updatedAt: now, promotionExpiresAt: null }).where(eq(adapterAuthSessions.id, row.id));
      nativeIds.delete(record.id);
      return true;
    }));
  }
  function startReaper(log: () => void) {
    if (!nativeAdapterLoginSupported(env) || timer) return;
    const sweep = () => {
      if (sweeping) return;
      sweeping = reap().catch(log).finally(() => { sweeping = null; });
    };
    sweep(); timer = setInterval(sweep, 30_000); timer.unref();
  }
  async function shutdown() {
    if (timer) clearInterval(timer);
    timer = null;
    await sweeping;
    await runtime?.shutdown();
    nativeIds.clear();
  }
  const controller = { assertRequest, assertScope, deviceRuntime, setupTokenProvider, releaseNativeLease, startReaper, shutdown };
  if (env === process.env) productionControllers.set(db, controller);
  return controller;
}
