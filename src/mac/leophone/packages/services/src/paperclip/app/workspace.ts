import type { NativePaperclipPort, PaperclipPreferences } from "@zcode/shared";
import { createUuid } from "@zcode/shared";
import type {
  IPaperclipWorkspace,
  PaperclipCommand,
  PaperclipDetail,
  PaperclipSnapshot,
} from "../contract.js";
import {
  creationRetryPermitted,
  normalizePaperclipOrigin,
  paperclipId,
  paperclipIdentityKey,
} from "../domain/identity.js";
import {
  emptyPaperclipSnapshot,
  agentSchema,
  approvalSchema,
  attachmentSchema,
  commentSchema,
  companySchema,
  healthSchema,
  issueSchema,
  logSchema,
  runSchema,
  sessionSchema,
} from "./responses.js";

import { buildPaperclipMutation, verifyPaperclipMutation } from "./mutations.js";

class OperationError extends Error {
  constructor(
    message: string,
    readonly kind: "unknown" | "rejected" | "signed-out" = "rejected",
  ) {
    super(message);
  }
}

/** 服务器拥有业务状态；此协调者只拥有读投影、发布代际和单次提交的回执。 */
export class PaperclipWorkspace implements IPaperclipWorkspace {
  private state = emptyPaperclipSnapshot();
  private preferences: PaperclipPreferences = { origin: "", companies: {} };
  private listeners = new Set<() => void>();
  private loadedCount = 0;
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
        generation = this.reset();
      }
      this.publish(generation, {
        error: error instanceof Error ? error.message : "服务器操作失败，请重试。",
      });
      throw error;
    } finally {
      this.publish(generation, { busy: false });
    }
  }
  private async api(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown,
    userId = this.state.user?.id,
    origin = this.state.origin,
  ): Promise<unknown> {
    let reply: { status: number; data: unknown };
    try {
      reply = await this.port.request({
        serverUrl: origin,
        path,
        method,
        body,
        expectedUserId: userId,
      });
    } catch {
      throw new OperationError(
        method === "GET"
          ? "无法连接服务器，请检查网络后刷新。"
          : "提交结果待确认，请先刷新核对。不会自动重发或转为本机执行。",
        method === "GET" ? "rejected" : "unknown",
      );
    }
    if (reply.status === 401) throw new OperationError("登录已过期，请重新登录。", "signed-out");
    if (reply.status === 403) throw new OperationError("当前用户没有执行此操作的权限。");
    if (reply.status < 200 || reply.status >= 300) {
      const unknown = method !== "GET" && reply.status >= 500;
      throw new OperationError(
        unknown
          ? "提交结果待确认，请刷新核对后决定。"
          : `服务器请求失败（HTTP ${reply.status}），请刷新后核对。`,
        unknown ? "unknown" : "rejected",
      );
    }
    return reply.data;
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
    healthSchema.parse(await this.api("/api/health", "GET", undefined, undefined, origin));
    const session = sessionSchema.safeParse(
      await this.api("/api/auth/get-session", "GET", undefined, undefined, origin),
    );
    if (!session.success)
      throw new OperationError("尚未登录，请打开服务器网页登录。", "signed-out");
    const user = session.data.user;
    const companies = companySchema
      .array()
      .parse(await this.api("/api/companies?scope=accessible", "GET", undefined, user.id, origin));
    const preferred = this.preferences.companies[paperclipIdentityKey(origin, user.id)];
    const companyId =
      companies.find((company) => company.id === preferred)?.id ?? companies[0]?.id ?? "";
    this.publish(generation, { user, companies, companyId });
    if (generation === this.state.generation && companyId) await this.readWorkspace(generation);
  }
  async signIn(): Promise<void> {
    if (!this.state.origin) throw new OperationError("请先保存服务器地址。");
    const generation = this.reset();
    await this.action(generation, async () => {
      const result = await this.port.signIn({ serverUrl: this.state.origin });
      if (generation !== this.state.generation) return;
      if (!result.completed) throw new OperationError("登录已取消，可重新打开登录窗口。");
      await this.connect(generation);
    });
  }
  async signOut(): Promise<void> {
    const origin = this.state.origin;
    const generation = this.reset();
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
      receipts: {},
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
    const root = `/api/companies/${paperclipId(companyId)}`;
    const offset = loadMore ? this.loadedCount : 0;
    let consumed = offset;
    const rows = [];
    let hasMore = false;
    do {
      const page = issueSchema
        .array()
        .parse(
          await this.api(
            `${root}/issues?limit=100&offset=${consumed}`,
            "GET",
            undefined,
            user.id,
            origin,
          ),
        );
      rows.push(...page);
      consumed += page.length;
      hasMore = page.length === 100;
      if (!hasMore || loadMore) break;
    } while (consumed < this.loadedCount);
    const agents = agentSchema
      .array()
      .parse(await this.api(`${root}/agents`, "GET", undefined, user.id, origin));
    if (
      rows.some((row) => row.companyId !== companyId) ||
      agents.some((row) => row.companyId !== companyId)
    )
      throw new OperationError("服务器返回了其他公司的数据，已阻止。");
    if (generation !== this.state.generation) return;
    const unique = new Map(
      (loadMore ? [...this.state.issues, ...rows] : rows).map((row) => [row.id, row]),
    );
    this.loadedCount = consumed;
    this.publish(generation, { issues: [...unique.values()], agents, hasMore });
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
    const path = `/api/issues/${paperclipId(issueId)}`;
    const read = (suffix = "") => this.api(path + suffix, "GET", undefined, user.id, origin);
    const [rawIssue, rawComments, rawRuns, rawApprovals, rawAttachments] = await Promise.all([
      read(),
      read("/comments?order=asc"),
      read("/runs"),
      read("/approvals"),
      read("/attachments"),
    ]);
    const detail = {
      issue: issueSchema.parse(rawIssue),
      comments: commentSchema.array().parse(rawComments),
      runs: runSchema.array().parse(rawRuns),
      approvals: approvalSchema.array().parse(rawApprovals),
      attachments: attachmentSchema.array().parse(rawAttachments),
    };
    if (
      detail.issue.id !== issueId ||
      detail.issue.companyId !== companyId ||
      [...detail.comments, ...detail.attachments].some(
        (item) => item.companyId !== companyId || item.issueId !== issueId,
      ) ||
      detail.approvals.some((item) => item.companyId !== companyId)
    )
      throw new OperationError("任务归属与当前公司不一致，已阻止。");
    return detail;
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
    const { origin, user, companyId, generation } = this.context();
    const id = "requestId" in command ? command.requestId : createUuid();
    if ("retry" in command && !command.retry && this.state.receipts[id]?.state === "unknown")
      throw new OperationError("原提交结果未知，需核对后手动重试。");
    if (command.kind === "create" && !creationRetryPermitted(command.firstSubmittedAt))
      throw new OperationError(
        "创建提交已超出 7 天去重窗口或缺少可信时间，请先核对任务列表。草稿已保留。",
      );
    await this.action(generation, async () => {
      let sent = false;
      try {
        if (command.kind !== "create") {
          if (command.issueId !== this.state.selectedIssueId)
            throw new OperationError("当前任务已改变，请重新选择任务。");
          const detail = await this.readDetail(command.issueId);
          if (generation !== this.state.generation)
            throw new OperationError("当前工作区已改变，操作未发送。");
          if (
            command.kind === "approval" &&
            !detail.approvals.some(
              (item) => item.id === command.approvalId && item.status === "pending",
            )
          )
            throw new OperationError("审批已改变，请刷新后核对。");
          if (
            command.kind === "cancel" &&
            !detail.runs.some(
              (run) => run.runId === command.runId && ["running", "queued"].includes(run.status),
            )
          )
            throw new OperationError("此任务运行已结束或不属于当前任务。");
        }
        const mutation = buildPaperclipMutation(command, companyId, id);
        sent = true;
        const raw = await this.api(mutation.path, mutation.method, mutation.body, user.id, origin);
        const createdIssueId = verifyPaperclipMutation(command, raw, companyId, id);
        if (createdIssueId) this.publish(generation, { selectedIssueId: createdIssueId });
        this.publish(generation, {
          receipts: { ...this.state.receipts, [id]: { id, state: "confirmed" } },
        });
      } catch (error) {
        const unknown = sent && !(error instanceof OperationError && error.kind !== "unknown");
        const message = unknown
          ? "提交结果待确认，请刷新核对。不会自动重发。"
          : error instanceof Error
            ? error.message
            : "操作未完成。";
        this.publish(generation, {
          receipts: {
            ...this.state.receipts,
            [id]: { id, state: unknown ? "unknown" : "rejected", message },
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
  async readLog(runId: string): Promise<void> {
    const { generation, origin, user } = this.context();
    const issueId = this.state.selectedIssueId;
    if (!issueId) throw new OperationError("请先选择任务。");
    await this.action(generation, async () => {
      const detail = await this.readDetail(issueId);
      if (!detail.runs.some((run) => run.runId === runId))
        throw new OperationError("运行不属于当前任务。");
      const log = logSchema.parse(
        await this.api(
          `/api/heartbeat-runs/${paperclipId(runId)}/log?offset=0&limitBytes=64000`,
          "GET",
          undefined,
          user.id,
          origin,
        ),
      );
      if (log.runId !== runId) throw new OperationError("日志归属不兼容。");
      this.publish(generation, { log });
    });
  }
  async downloadAttachment(attachmentId: string): Promise<void> {
    const { generation, origin, user } = this.context();
    const issueId = this.state.selectedIssueId;
    if (!issueId) throw new OperationError("请先选择任务。");
    await this.action(generation, async () => {
      const detail = await this.readDetail(issueId);
      const attachment = detail.attachments.find((item) => item.id === attachmentId);
      if (!attachment || generation !== this.state.generation)
        throw new OperationError("附件不属于当前任务，或工作区已改变。");
      const permitted = [
        `/api/attachments/${paperclipId(attachment.id)}/content`,
        `/api/assets/${paperclipId(attachment.assetId)}/content`,
      ];
      if (!permitted.includes(attachment.contentPath))
        throw new OperationError("附件下载路径不兼容，已阻止。");
      await this.port.download({
        serverUrl: origin,
        path: attachment.contentPath,
        filename: attachment.originalFilename ?? "Paperclip-附件",
        expectedUserId: user.id,
      });
    });
  }
}
