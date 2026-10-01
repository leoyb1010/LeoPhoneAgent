import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeDurableJson } from "./durableJson.js";
import type { Caller } from "./session.js";

type Grant = {
  digest: string;
  caller: Caller;
  expiresAt: number;
  scopes?: ("harness" | "sync" | "treasury")[];
};
type State = { version: 1; targetDeviceId?: string; grants: Grant[]; revokedDeviceIds: string[] };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** 本机授权事实；调用者来自可信 relay frame 或已验证 token，不来自 HTTP caller header。 */
export class DirectGrants {
  private state: State = { version: 1, grants: [], revokedDeviceIds: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private codes = new Map<string, number>();
  constructor(
    private readonly file: string,
    readonly targetDeviceId: string,
    private readonly now = () => Date.now(),
    private readonly allowedScopes: ("harness" | "sync" | "treasury")[] = ["harness"],
  ) {}

  async restore(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as State;
      if (
        value.version !== 1 ||
        value.targetDeviceId !== this.targetDeviceId ||
        !Array.isArray(value.grants) ||
        !Array.isArray(value.revokedDeviceIds) ||
        value.revokedDeviceIds.some((id) => typeof id !== "string") ||
        value.grants.some(
          (grant) =>
            typeof grant.digest !== "string" ||
            !/^[a-f0-9]{64}$/.test(grant.digest) ||
            !Number.isFinite(grant.expiresAt) ||
            !grant.caller?.deviceId ||
            !["iphone", "legacy", "master"].includes(grant.caller.kind) ||
            (grant.scopes !== undefined && (!Array.isArray(grant.scopes) || grant.scopes.some((scope) => !["harness", "sync", "treasury"].includes(scope)))),
        )
      )
        throw new Error("Invalid direct grant registry");
      this.state = value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    this.loaded = true;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  isRevoked(caller: Caller): boolean {
    return Boolean(caller.deviceId && this.state.revokedDeviceIds.includes(caller.deviceId));
  }

  issue(
    caller: Caller,
  ): Promise<{
    token: string;
    targetDeviceId: string;
    expiresAt: number;
    scopes: ("harness" | "sync" | "treasury")[];
  }> {
    return this.serial(async () => {
      if (!this.loaded || !caller.deviceId || caller.kind === "unknown" || this.isRevoked(caller))
        throw new Error("Caller is not authorized for direct access");
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Math.floor(this.now() / 1000) + 30 * 24 * 60 * 60;
      const next: State = {
        ...this.state,
        targetDeviceId: this.targetDeviceId,
        grants: [
          ...this.state.grants.filter((grant) => grant.expiresAt > this.now() / 1000),
          {
            digest: digest(token),
            caller: { ...caller },
            expiresAt,
            scopes: [...this.allowedScopes],
          },
        ],
      };
      // 单设备最多保留最近 8 把，避免断线重配无限增长；撤销仍按 caller 一次撤回所有路径。
      const own = next.grants.filter((grant) => grant.caller.deviceId === caller.deviceId);
      const removed = new Set(own.slice(0, Math.max(0, own.length - 8)));
      next.grants = next.grants.filter((grant) => !removed.has(grant));
      await writeDurableJson(this.file, next);
      this.state = next;
      return {
        token,
        targetDeviceId: this.targetDeviceId,
        expiresAt,
        scopes: [...this.allowedScopes],
      };
    });
  }

  authenticate(token: string, target: string): Caller | null {
    if (!this.loaded || target !== this.targetDeviceId || token.length > 256) return null;
    const grant = this.state.grants.find((item) => item.digest === digest(token));
    return grant && grant.expiresAt > this.now() / 1000 && !this.isRevoked(grant.caller)
      ? { ...grant.caller }
      : null;
  }

  hasScope(token: string, target: string, scope: "harness" | "sync" | "treasury"): boolean {
    if (!this.authenticate(token, target)) return false;
    const grant = this.state.grants.find((item) => item.digest === digest(token));
    return (grant?.scopes ?? ["harness"]).includes(scope);
  }

  revoke(deviceId: string): Promise<void> {
    return this.revokeMany([deviceId]);
  }

  revokeMany(deviceIds: string[]): Promise<void> {
    return this.serial(async () => {
      if (!this.loaded || deviceIds.some((id) => !id || id.length > 256))
        throw new Error("Invalid revocation");
      const revoked = new Set([...this.state.revokedDeviceIds, ...deviceIds]);
      // 中继每次重连都会重发完整撤销快照;没有新设备且上次已落盘,就不重写 grants.json。
      const unchanged =
        revoked.size === this.state.revokedDeviceIds.length &&
        !this.state.grants.some((item) => revoked.has(item.caller.deviceId ?? ""));
      if (unchanged && !this.revocationUnsaved) return;
      const next: State = {
        ...this.state,
        targetDeviceId: this.targetDeviceId,
        revokedDeviceIds: [...revoked],
        grants: this.state.grants.filter((item) => !revoked.has(item.caller.deviceId ?? "")),
      };
      // 整批先拒绝再写盘；逐个 await 会在首个失败后漏掉其他设备的 direct 授权。
      this.state = next;
      this.revocationUnsaved = true;
      await writeDurableJson(this.file, next);
      this.revocationUnsaved = false;
    });
  }

  /** 内存里已拒绝、但上次写盘失败:下一次撤销(哪怕是重复快照)必须补写。 */
  private revocationUnsaved = false;

  /** 只能由本机受信管理入口调用，绝不开放在 direct listener。 */
  createPairingCode(): { join: string; exp: number; deviceId: string } {
    if (!this.loaded) throw new Error("Direct grants unavailable");
    const join = randomBytes(32).toString("base64url");
    const exp = Math.floor(this.now() / 1000) + 300;
    for (const [key, expiry] of this.codes) if (expiry <= this.now() / 1000) this.codes.delete(key);
    this.codes.set(digest(join), exp);
    return { join, exp, deviceId: this.targetDeviceId };
  }

  revokePairingCode(join: string): void {
    this.codes.delete(digest(join));
  }

  devices(): { deviceId: string; name: string; expiresAt: number }[] {
    const byId = new Map<string, { deviceId: string; name: string; expiresAt: number }>();
    for (const grant of this.state.grants) {
      if (grant.expiresAt <= this.now() / 1000 || this.isRevoked(grant.caller)) continue;
      const deviceId = grant.caller.deviceId!;
      const old = byId.get(deviceId);
      if (!old || old.expiresAt < grant.expiresAt)
        byId.set(deviceId, {
          deviceId,
          name: grant.caller.name ?? deviceId,
          expiresAt: grant.expiresAt,
        });
    }
    return [...byId.values()];
  }

  async redeem(
    join: string,
    target: string,
    name: string,
  ): Promise<{ token: string; targetDeviceId: string; expiresAt: number } | null> {
    const key = digest(join);
    const expiry = this.codes.get(key);
    if (target !== this.targetDeviceId || !expiry || expiry <= this.now() / 1000) return null;
    this.codes.delete(key); // await 前消费，两个并发兑换不能领两把钥匙。
    return this.issue({
      kind: "legacy",
      deviceId: `direct-${randomUUID()}`,
      name: name.slice(0, 100),
    });
  }
}
