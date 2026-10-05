import { createUuid, type NativePaperclipPort, type PaperclipPreferences, type PaperclipStoredReceipt } from "@zcode/shared";
import type {
  IPaperclipWorkspace,
  PaperclipCommand,
  PaperclipDetail,
  PaperclipSnapshot,
} from "../contract.js";
import { normalizePaperclipOrigin, paperclipIdentityKey } from "../domain/identity.js";
import { emptyPaperclipSnapshot, companySchema, sessionSchema } from "./responses.js";
import {
  buildPaperclipMutation,
  verifyPaperclipMutation,
  verifyPaperclipCommandRelation,
  verifyLatestApproval,
} from "./mutations.js";
import {
  readBoundWorkspace,
  readBoundDetail,
  readBoundLog,
  downloadBoundAttachment,
} from "./reads.js";
import { receiptsFor, updateReceipt, pendingReceipt, preSendRefusal } from "./receipts.js";
import { OperationError, requestPaperclip, assertPaperclipReady, paperclipLog as log } from "./api.js";
import { normalizeStatusCommand, readReconciliation } from "./reconcile.js";

export class PaperclipWorkspace implements IPaperclipWorkspace {
  private state = emptyPaperclipSnapshot();
  private preferences: PaperclipPreferences = { origin: "", companies: {} };
  private listeners = new Set<() => void>();
  private loadedCount = 0;
  private lastUser: { origin: string; userId: string } | null = null;
  constructor(private readonly port: NativePaperclipPort) {}
  getSnapshot = (): PaperclipSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(generation: number, patch: Partial<PaperclipSnapshot>): void {
    if (generation !== this.state.generation) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private reset(origin = this.state.origin): number {
    this.loadedCount = 0;
    this.state = { ...emptyPaperclipSnapshot(), generation: this.state.generation + 1, origin };
    for (const listener of this.listeners) listener();
    return this.state.generation;
  }
  private context() {
    const { origin, user, companyId, generation } = this.state;
    if (!origin || !user || !companyId) throw new OperationError("请先登录并选择公司。");
    return { origin, user, companyId, generation };
  }
  private async action(generation: number, operation: () => Promise<void>): Promise<void> {
    if (this.state.busy) throw new OperationError("正在同步，请稍后重试。");
    this.publish(generation, { busy: true, error: null });
    try {
      await operation();
    } catch (error) {
      if (
        generation === this.state.generation &&
        error instanceof OperationError &&
        error.kind === "signed-out"
      ) {
        log.warn(undefined, "服务器会话已失效（401），清空当前身份投影");
        generation = this.reset();
      }
      this.publish(generation, {
        ...(error instanceof OperationError && error.kind === "unready" ? { ready: false } : {}),
        error: error instanceof Error ? error.message : "服务器操作失败，请重试。",
      });
      throw error;
    } finally {
      this.publish(generation, { busy: false });
    }
  }
  private api(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
    userId = this.state.user?.id,
    origin = this.state.origin,
  ): Promise<unknown> {
    return requestPaperclip(this.port, path, method, body, userId, origin);
  }
  async initialize(): Promise<void> {
    this.preferences = await this.port.getPreferences();
    if (this.preferences.origin) await this.configure(this.preferences.origin);
  }
  async configure(value: string): Promise<void> {
    const origin = normalizePaperclipOrigin(value);
    const generation = this.reset(origin);
    await this.action(generation, async () => {
      this.preferences = { ...this.preferences, origin };
      await this.port.setPreferences(this.preferences);
      await this.connect(generation);
    });
  }
  private async connect(generation: number): Promise<void> {
    const origin = this.state.origin;
    assertPaperclipReady(await this.api("/api/health", "GET", undefined, undefined, origin));
    const session = sessionSchema.safeParse(
      await this.api("/api/auth/get-session", "GET", undefined, undefined, origin),
    );
    if (!session.success)
      throw new OperationError("尚未登录，请打开服务器网页登录。", "signed-out");
    const user = session.data.user;
    if (this.lastUser?.origin === origin && this.lastUser.userId !== user.id)
      log.info(undefined, "服务器账号已切换，旧账号回执与草稿保持隔离");
    this.lastUser = { origin, userId: user.id };
    const companies = companySchema
      .array()
      .parse(await this.api("/api/companies?scope=accessible", "GET", undefined, user.id, origin));
    const preferred = this.preferences.companies[paperclipIdentityKey(origin, user.id)];
    const companyId =
      companies.find((company) => company.id === preferred)?.id ?? companies[0]?.id ?? "";
    this.publish(generation, {
      ready: true,
      user,
      companies,
      companyId,
      receipts: receiptsFor(this.preferences, paperclipIdentityKey(origin, user.id, companyId)),
    });
    if (generation === this.state.generation && companyId) await this.readWorkspace(generation);
  }
  async signIn(): Promise<void> {
    if (!this.state.origin) throw new OperationError("请先保存服务器地址。");
    const generation = this.reset();
    await this.action(generation, async () => {
      assertPaperclipReady(await this.api("/api/health"));
      if (generation !== this.state.generation) return;
      const result = await this.port.signIn({ serverUrl: this.state.origin });
      if (generation !== this.state.generation) return;
      log.info(undefined, `登录窗口结束 completed=${result.completed}`);
      if (!result.completed) throw new OperationError("登录已取消，可重新打开登录窗口。");
      await this.connect(generation);
    });
  }
  async signOut(): Promise<void> {
    const origin = this.state.origin;
    const generation = this.reset();
    log.info(undefined, "用户注销服务器会话");
    await this.action(generation, () => this.port.signOut({ serverUrl: origin }));
  }
  async selectCompany(companyId: string): Promise<void> {
    const { origin, user } = this.context();
    if (!this.state.companies.some((company) => company.id === companyId))
      throw new OperationError("当前用户不能访问此公司。");
    const generation = this.state.generation + 1;
    this.loadedCount = 0;
    this.state = {
      ...this.state,
      generation,
      companyId,
      busy: false,
      issues: [],
      agents: [],
      detail: null,
      selectedIssueId: null,
      log: null,
      receipts: receiptsFor(this.preferences, paperclipIdentityKey(origin, user.id, companyId)),
    };
    this.publish(generation, {});
    await this.action(generation, async () => {
      this.preferences.companies[paperclipIdentityKey(origin, user.id)] = companyId;
      await this.port.setPreferences(this.preferences);
      if (generation === this.state.generation) await this.readWorkspace(generation);
    });
  }
  private async readWorkspace(generation: number, loadMore = false): Promise<void> {
    const { companyId, user, origin } = this.context();
    assertPaperclipReady(await this.api("/api/health", "GET", undefined, user.id, origin));
    this.publish(generation, { ready: true });
    const { rows, agents, consumed, hasMore } = await readBoundWorkspace(
      (path) => this.api(path, "GET", undefined, user.id, origin),
      companyId,
      this.loadedCount,
      loadMore,
    );
    if (generation !== this.state.generation) return;
    const unique = new Map(
      (loadMore ? [...this.state.issues, ...rows] : rows).map((row) => [row.id, row]),
    );
    this.loadedCount = consumed;
    this.publish(generation, {
      issues: [...unique.values()],
      agents,
      hasMore,
      receipts: {
        ...this.state.receipts,
        ...receiptsFor(this.preferences, paperclipIdentityKey(origin, user.id, companyId)),
      },
    });
    if (this.state.selectedIssueId) {
      const detail = await this.readDetail(this.state.selectedIssueId);
      this.publish(generation, { detail });
    }
  }
  async refresh(loadMore = false): Promise<void> {
    const { generation } = this.context();
    await this.action(generation, () => this.readWorkspace(generation, loadMore));
  }
  private async readDetail(issueId: string): Promise<PaperclipDetail> {
    const { origin, user, companyId } = this.context();
    return readBoundDetail(
      (path) => this.api(path, "GET", undefined, user.id, origin),
      companyId,
      issueId,
    );
  }
  async selectIssue(issueId: string): Promise<void> {
    this.context();
    const generation = this.state.generation + 1;
    this.state = {
      ...this.state,
      generation,
      selectedIssueId: issueId,
      detail: null,
      log: null,
      busy: false,
    };
    this.publish(generation, {});
    await this.action(generation, async () => {
      this.publish(generation, { detail: await this.readDetail(issueId) });
    });
  }
  async command(command: PaperclipCommand): Promise<void> {
    if (command.kind === "archive") return this.archiveReceipt(command.receiptId);
    if (command.kind === "reconcile") return this.reconcileReceipt(command.receiptId);
    command = normalizeStatusCommand(command);
    const { origin, user, companyId, generation } = this.context();
    const id = "requestId" in command ? command.requestId : createUuid();
    const identity = paperclipIdentityKey(origin, user.id, companyId);
    const receipts = { ...this.state.receipts, ...receiptsFor(this.preferences, identity) };
    const previous = receipts[id];
    const receipt = pendingReceipt(command, identity, id, previous?.submittedAt);
    // 修复审计 P2「发送前被拒锁草稿」：准入拒绝确定未发出，发布 rejected 回执让 UI 回滚 submitted
    // 并保留原文与请求编号；原回执已是 unknown 的重试不改写，前置拒绝不能证明原提交未被接收。
    const refusal = preSendRefusal(this.state.busy, receipts, command, previous);
    if (refusal) {
      log.warn(undefined, `提交在发送前被拒绝 kind=${command.kind} reason=${refusal.reason}`);
      if (previous?.state !== "unknown") {
        const rejected = { ...receipt, state: "rejected" as const, message: refusal.message };
        this.publish(generation, { receipts: { ...this.state.receipts, [id]: rejected } });
      }
      throw new OperationError(refusal.message);
    }
    await this.action(generation, async () => {
      let sent = false;
      try {
        assertPaperclipReady(await this.api("/api/health", "GET", undefined, user.id, origin));
        if (command.kind !== "create") {
          if (command.issueId !== this.state.selectedIssueId)
            throw new OperationError("当前任务已改变，请重新选择任务。");
          const detail = await this.readDetail(command.issueId);
          if (generation !== this.state.generation)
            throw new OperationError("当前工作区已改变，操作未发送。");
          verifyPaperclipCommandRelation(command, detail);
        }
        await this.persistReceipt(identity, id, receipt);
        if (command.kind === "approval") {
          await verifyLatestApproval(
            (path) => this.api(path, "GET", undefined, user.id, origin),
            command,
          );
        }
        if (generation !== this.state.generation)
          throw new OperationError("当前工作区已改变，操作未发送。");
        const mutation = buildPaperclipMutation(command, companyId, id, user.id);
        sent = true;
        const raw = await this.api(mutation.path, mutation.method, mutation.body, user.id, origin);
        const createdIssueId = verifyPaperclipMutation(command, raw, companyId, id, user.id);
        if (command.kind === "cancel")
          await readReconciliation(
            (path) => this.api(path, "GET", undefined, user.id, origin),
            receipt,
            user.id,
            companyId,
          );
        await this.persistReceipt(identity, id);
        if (createdIssueId) this.publish(generation, { selectedIssueId: createdIssueId });
        this.publish(generation, {
          receipts: { ...this.state.receipts, [id]: { ...receipt, state: "confirmed" } },
          confirmedReply:
            command.kind === "comment"
              ? { receiptId: id, identity, issueId: command.issueId, body: command.body }
              : this.state.confirmedReply,
        });
      } catch (error) {
        const unknown =
          previous?.state === "unknown" ||
          (sent && !(error instanceof OperationError && error.kind !== "unknown"));
        if (!unknown) {
          try {
            await this.persistReceipt(identity, id);
          } catch {
            /* 未发送或明确拒绝不创建重放路径。 */
          }
        }
        const message = unknown
          ? "提交结果待确认，请刷新核对。不会自动重发。"
          : error instanceof Error
            ? error.message
            : "操作未完成。";
        this.publish(generation, {
          receipts: {
            ...this.state.receipts,
            [id]: {
              ...receipt,
              state: unknown ? "unknown" : "rejected",
              message,
            },
          },
        });
        throw new OperationError(
          message,
          unknown ? "unknown" : error instanceof OperationError ? error.kind : "rejected",
        );
      }
    });
    if (generation === this.state.generation) await this.refresh();
  }
  private async persistReceipt(
    identity: string,
    id: string,
    receipt?: PaperclipStoredReceipt,
  ): Promise<void> {
    const preferences = updateReceipt(this.preferences, identity, id, receipt);
    await this.port.setPreferences(preferences);
    this.preferences = { ...this.preferences, receipts: preferences.receipts };
  }
  private async reconcileReceipt(id: string): Promise<void> {
    const { origin, user, companyId, generation } = this.context();
    const identity = paperclipIdentityKey(origin, user.id, companyId);
    const receipt = this.preferences.receipts?.find(
      (row) => row.identity === identity && row.id === id && row.state === "unknown",
    );
    if (!receipt) throw new OperationError("当前身份没有此待核对操作。");
    await this.action(generation, async () => {
      assertPaperclipReady(await this.api("/api/health", "GET", undefined, user.id, origin));
      await readReconciliation(
        (path) => this.api(path, "GET", undefined, user.id, origin),
        receipt,
        user.id,
        companyId,
      );
      await this.persistReceipt(identity, id);
      this.publish(generation, {
        receipts: { ...this.state.receipts, [id]: { ...receipt, state: "confirmed" } },
      });
    });
    if (generation === this.state.generation) await this.refresh();
  }
  private async archiveReceipt(id: string): Promise<void> {
    const { origin, user, companyId, generation } = this.context();
    const identity = paperclipIdentityKey(origin, user.id, companyId);
    const receipt = this.preferences.receipts?.find(
      (row) => row.identity === identity && row.id === id && row.state === "unknown",
    );
    if (!receipt) throw new OperationError("当前身份没有此待核对操作。");
    await this.action(generation, async () => {
      await this.persistReceipt(identity, id, { ...receipt, state: "archived" });
      this.publish(generation, {
        receipts: { ...this.state.receipts, [id]: { ...receipt, state: "archived" } },
      });
    });
  }
  async readLog(runId: string): Promise<void> {
    const { generation, origin, user } = this.context();
    const issueId = this.state.selectedIssueId;
    if (!issueId) throw new OperationError("请先选择任务。");
    await this.action(generation, async () => {
      const detail = await this.readDetail(issueId);
      const log = await readBoundLog(
        (path) => this.api(path, "GET", undefined, user.id, origin),
        detail,
        runId,
        this.state.log,
      );
      this.publish(generation, { log });
    });
  }
  async downloadAttachment(attachmentId: string): Promise<void> {
    const { generation, origin, user } = this.context();
    const issueId = this.state.selectedIssueId;
    if (!issueId) throw new OperationError("请先选择任务。");
    await this.action(generation, async () => {
      const detail = await this.readDetail(issueId);
      if (generation !== this.state.generation)
        throw new OperationError("附件不属于当前任务，或工作区已改变。");
      await downloadBoundAttachment(this.port, detail, attachmentId, origin, user.id);
    });
  }
}
