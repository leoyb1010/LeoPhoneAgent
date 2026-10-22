import { promises as fsp } from "node:fs";
import path from "node:path";

import { writeDurableJson } from "./durableJson.js";

/**
 * [remote-ctl-mac] 定时任务要不要推送给手机(docs/specs/leo-link-remote-controls.md「关注」的 notify)。
 * 自动化服务是自动化的所有者,但它没有这个字段;notify 只是 Leo Link 的推送偏好,记在 Link 自己的文件里
 * (automation-notify.json,automationId → boolean)。没记过的 = false(桌面建的)。
 *
 * 升级前手机建的定时任务没有记录:第一次读时从操作回执(operations/*.json,手机经 Link POST /automations
 * 建任务必带操作编号,回执里有 automation_created 检查点或 201 响应里的 automation.id)认出它们,记成 true ——
 * 这样它们和升级前一样「跑完推送」;桌面建的没有回执,记成 false。只迁移一次,之后以文件为准。
 */
export class AutomationNotify {
  private entries = new Map<string, boolean>();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string | null,
    private readonly receiptsDir: string | null,
  ) {}

  load(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.file) return;
      try {
        const parsed = JSON.parse(await fsp.readFile(this.file, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          for (const [id, value] of Object.entries(parsed)) if (typeof value === "boolean") this.entries.set(id, value);
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return; // 坏文件:当没记过,不重新迁移
      }
      for (const id of await linkCreatedAutomations(this.receiptsDir)) this.entries.set(id, true);
      await this.persist().catch(() => undefined);
    })();
    return this.loading;
  }

  /** 同步读(已 load 过);没记过 = false。 */
  get(automationId: string): boolean {
    return this.entries.get(automationId) ?? false;
  }

  async set(automationId: string, notify: boolean): Promise<void> {
    await this.load();
    this.entries.set(automationId, notify);
    await this.persist();
  }

  async remove(automationId: string): Promise<void> {
    await this.load();
    if (this.entries.delete(automationId)) await this.persist();
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const value = Object.fromEntries(this.entries);
    this.writing = this.writing.catch(() => undefined).then(() => writeDurableJson(file, value));
    return this.writing;
  }
}

async function linkCreatedAutomations(dir: string | null): Promise<string[]> {
  if (!dir) return [];
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const ids = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")) as Record<string, unknown>;
      const checkpoint = (receipt["checkpoint"] ?? {}) as Record<string, unknown>;
      if (checkpoint["stage"] === "automation_created" && typeof checkpoint["automationId"] === "string")
        ids.add(checkpoint["automationId"]);
      const response = (receipt["response"] ?? {}) as { status?: unknown; body?: { automation?: { id?: unknown } } };
      const id = response.body?.automation?.id;
      if (response.status === 201 && typeof id === "string") ids.add(id);
    } catch {
      // 读不了的回执跳过。
    }
  }
  return [...ids];
}
