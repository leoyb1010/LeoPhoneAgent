import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMode } from "@zcode/shared";

import { fetchDesktopTasks, type DesktopTask } from "./desktopTasks.js";
import type { HarnessEvent } from "./journal.js";
import { LeoagentForwarder } from "./leoagentForward.js";
import { error, expandHome, isLinkPath, mayUseFullAuto, record, validSessionId } from "./linkPolicy.js";
import { resumeEnvelope } from "./resumeEnvelope.js";
import { APPROVAL_CHOICES, LinkSession, type ApprovalChoice, type Caller } from "./session.js";

export type LinkRequest = { method: string; path: string; body?: unknown; caller: Caller; requestId?: string };
export type LinkResponse = { status: number; body: unknown };
type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

export type LinkBridgeDeps = {
  taskService: IZCodeTaskService;
  logger: Logger;
  /** 已落盘的关键事件(审批、终态)交给中继发推送。 */
  push: (event: HarnessEvent) => void;
  appVersion: string | null;
  journalDir: string;
  /** 本机 leoagent(Python,:8646)跑 claude / codex / grok;没有就只剩 ZCode。 */
  leoagent: { url: string; key: () => string | null };
  /** Mac 上最近打开的本机工作区(设置里的 lastWorkspaceSession);手机据此看到桌面上开的任务。 */
  recentWorkspaces?: () => Promise<string[]>;
};

const VERSION = "0.4.0";
const ZCODE = "zcode";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** 重启后认回的任务数上限;更老的手机上也早就翻不到了。 */
const INDEX_LIMIT = 50;

/**
 * [leo-link] 手机协议 v0.4 在新 Mac 上的实现。中继帧在进程内交到这里,
 * 不经本机 38473 端口。ZCode 任务由这里直接驱动;claude / codex / grok 转给本机 leoagent。
 */
export class LinkBridge {
  private readonly sessions = new Map<string, LinkSession>();
  private readonly done = new Map<string, { at: number; response: Promise<LinkResponse> }>();
  /** 正在接管的桌面任务:同一个任务同时来两个请求时只接一次(否则两份日志写同一个文件、订阅泄漏)。 */
  private readonly adopting = new Map<string, Promise<LinkSession | null>>();
  /**
   * 连着的是中继 0.2(注册回执带 version):它会给每个请求附上调用方,这时认不出身份的请求一律按旧版设备对待。
   * 中继 0.1 不附调用方,所有请求都是 unknown —— 那时不能收紧,否则连你的 iPhone 也批不了命令。
   */
  strictCallers = false;
  /** 最近一次列出的桌面任务;接管时按它找工作区。 */
  private desktopTasks = new Map<string, DesktopTask>();

  private readonly leoagent: LeoagentForwarder;
  /** 认回任务期间不写任务表:这时只认回了一部分,写下去再赶上崩溃,没认回的那些就丢了。 */
  private restoring = false;
  private saveWanted = false;

  constructor(private readonly deps: LinkBridgeDeps) {
    this.leoagent = new LeoagentForwarder(deps.leoagent);
  }

  /** 读回任务表:Mac 重启后,手机上已有的任务照样能续传、续聊、审批。 */
  async restore(): Promise<void> {
    this.restoring = true;
    try {
      await this.restoreFromIndex();
    } finally {
      this.restoring = false;
      if (this.saveWanted) {
        this.saveWanted = false;
        void this.saveIndex();
      }
    }
  }

  private async restoreFromIndex(): Promise<void> {
    let entries: Record<string, unknown>[] = [];
    try {
      entries = JSON.parse(await fsp.readFile(this.indexPath(), "utf8")) as Record<string, unknown>[];
    } catch {
      return;
    }
    for (const entry of Array.isArray(entries) ? entries.slice(0, INDEX_LIMIT) : []) {
      const taskId = typeof entry["task_id"] === "string" ? entry["task_id"] : "";
      const cwd = typeof entry["cwd"] === "string" ? entry["cwd"] : "";
      if (!taskId || !cwd || this.sessions.has(taskId)) continue;
      const session = this.newSession(taskId, cwd, entry["mode"] === "yolo" ? "yolo" : "build");
      session.title = typeof entry["title"] === "string" ? entry["title"] : "";
      if (typeof entry["created_at"] === "number") session.createdAt = entry["created_at"];
      // 最后活动时间从创建时间起算,open() 再按日志最后一条事件往后推。以前这里取的是「现在」:
      // 每次 Mac 重启,手机上的旧任务都像刚动过,一直占着首页「进行中」。
      session.updatedAt = session.createdAt;
      session.needsResume = true;
      try {
        await session.open();
        this.sessions.set(taskId, session);
      } catch (cause) {
        this.deps.logger.warn("[leo/link] restore failed", { taskId, error: String(cause) });
      }
    }
  }

  private indexPath(): string {
    return path.join(this.deps.journalDir, "sessions.json");
  }

  private saving: Promise<void> = Promise.resolve();

  /** 串行写:几处同时触发时共用一个临时文件,并发 rename 会互相踩掉。 */
  private saveIndex(): Promise<void> {
    if (this.restoring) {
      this.saveWanted = true;
      return this.saving;
    }
    this.saving = this.saving.then(() => this.writeIndex());
    return this.saving;
  }

  private async writeIndex(): Promise<void> {
    const rows = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, INDEX_LIMIT)
      .map((session) => session.indexEntry());
    try {
      await fsp.mkdir(this.deps.journalDir, { recursive: true, mode: 0o700 });
      const temp = `${this.indexPath()}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(rows), { mode: 0o600 });
      await fsp.rename(temp, this.indexPath());
    } catch (cause) {
      this.deps.logger.warn("[leo/link] saving session index failed", { error: String(cause) });
    }
  }

  private newSession(taskId: string, cwd: string, mode: ZCodeTaskMode): LinkSession {
    return new LinkSession({ taskId, cwd, mode }, {
      taskService: this.deps.taskService,
      journalDir: this.deps.journalDir,
      push: this.deps.push,
      logger: this.deps.logger,
      strictCallers: () => this.strictCallers,
      onModeChanged: () => void this.saveIndex(),
    });
  }

  async handle(req: LinkRequest): Promise<LinkResponse> {
    const url = new URL(req.path, "http://link.invalid");
    if (!isLinkPath(url.pathname)) return error(404, "这个接口不对手机开放");
    const method = req.method.toUpperCase();
    if (method !== "POST" || !req.requestId) return this.route(method, url, req);
    // 幂等:同一个 request id 只执行一次 —— 手机重试和中继离线排队共用这个 id。
    this.pruneDone();
    const seen = this.done.get(req.requestId);
    if (seen) return seen.response;
    const response = this.route(method, url, req);
    this.done.set(req.requestId, { at: Date.now(), response });
    // 5xx 是没做成,允许重试;抛异常同样允许重试,且不能留下没人接的 rejection 拖垮 Host。
    const requestId = req.requestId;
    void response.then(
      (result) => {
        if (result.status >= 500) this.done.delete(requestId);
      },
      () => this.done.delete(requestId),
    );
    return response;
  }

  /** `/harness/sessions/:id/events` 的 SSE 数据行(不含 `data: ` 前缀)。 */
  async stream(req: LinkRequest, write: (data: string) => void, signal: AbortSignal): Promise<void> {
    const url = new URL(req.path, "http://link.invalid");
    const match = /^\/harness\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (!match) return;
    const sessionId = decodeURIComponent(match[1]!);
    if (!validSessionId(sessionId)) return;
    const session = this.sessions.get(sessionId) ?? (await this.adoptDesktopTask(sessionId));
    if (!session) {
      await this.leoagent.stream(url.pathname + url.search, write, signal);
      return;
    }
    const parsed = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    const after = Number.isNaN(parsed) ? 0 : parsed;
    write(JSON.stringify(resumeEnvelope(after, 0)));
    try {
      for await (const event of session.subscribe(after, { signal, journalStatus: url.searchParams.get("journal_status") === "1" })) {
        write(JSON.stringify(event));
      }
    } catch {
      // 手机走了是常态;任务照跑,日志照长,下次按 seq 续传。
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
  }

  // -- 路由 -------------------------------------------------------------------

  private async route(method: string, url: URL, req: LinkRequest): Promise<LinkResponse> {
    const pathname = url.pathname;
    if (pathname === "/health" && method === "GET") {
      return { status: 200, body: { status: "ok", platform: "leoagent", version: VERSION, server: "leophoneagent", app_version: this.deps.appVersion } };
    }
    if (pathname === "/v1/capabilities" && method === "GET") return this.capabilities();
    if (pathname === "/v1/grok/token" && method === "GET") return this.leoagent.request("GET", url.pathname);
    if (pathname === "/harness/full-auto" && method === "POST") return this.fullAutoOff(req);
    if (pathname === "/harness/sessions") {
      if (method === "GET") return this.list();
      if (method === "POST") return this.create(req);
      return error(405, "Method not allowed");
    }
    const match = /^\/harness\/sessions\/([^/]+)\/(send|approval|stop|archive)$/.exec(pathname);
    if (!match || method !== "POST") return error(405, "Method not allowed");
    const sessionId = decodeURIComponent(match[1]!);
    if (!validSessionId(sessionId)) return error(400, "会话 id 不合法");
    // 清理不接管桌面任务:没接过来的本来就不在手机的「进行中」里。
    if (match[2] === "archive") return this.archive(sessionId, url.pathname, req.body);
    const session = this.sessions.get(sessionId) ?? (await this.adoptDesktopTask(sessionId));
    if (!session) return this.leoagent.request("POST", url.pathname, req.body);
    const body = record(req.body);
    switch (match[2]) {
      case "send":
        return this.send(session, body, req.caller);
      case "approval":
        return this.approve(session, body, req.caller);
      default:
        await session.stop();
        return { status: 200, body: { ok: true, status: session.status } };
    }
  }

  /** Mac 最近打开的项目里的任务(手机自己开的已经在 sessions 里,不重复列)。读不到就当没有。 */
  private async listDesktopTasks(): Promise<DesktopTask[]> {
    const workspaces = await this.deps.recentWorkspaces?.().catch(() => []) ?? [];
    try {
      const tasks = (await fetchDesktopTasks(this.deps.taskService, workspaces))
        .filter((task) => !this.sessions.has(task.taskId));
      this.desktopTasks = new Map(tasks.map((task) => [task.taskId, task]));
      return tasks;
    } catch (cause) {
      this.deps.logger.warn("[leo/link] listing desktop tasks failed", { error: String(cause) });
      return [];
    }
  }

  /** 手机点开或给桌面任务发消息:接过来,之后和手机开的任务一样续传、审批、停止。 */
  private adoptDesktopTask(taskId: string): Promise<LinkSession | null> {
    const inFlight = this.adopting.get(taskId);
    if (inFlight) return inFlight;
    const adoption = this.adopt(taskId).finally(() => this.adopting.delete(taskId));
    this.adopting.set(taskId, adoption);
    return adoption;
  }

  private async adopt(taskId: string): Promise<LinkSession | null> {
    const task = this.desktopTasks.get(taskId);
    if (!task) return null;
    const session = this.newSession(task.taskId, task.cwd, task.mode);
    session.title = task.title;
    session.createdAt = task.createdAt / 1000;
    session.needsResume = true;
    this.sessions.set(taskId, session);
    this.desktopTasks.delete(taskId);
    try {
      await session.open();
    } catch (cause) {
      // 接不上就原样放回桌面任务清单,别留一个打不开的会话占着这个 id。
      this.sessions.delete(taskId);
      this.desktopTasks.set(taskId, task);
      await session.close().catch(() => undefined);
      throw cause;
    }
    if (session.seq === 0) {
      session.emit({ event: "session.note", text: `接上了 Mac 上的任务「${task.title || "未命名"}」:之前的对话在 Mac 上,这里从现在开始同步。` });
    }
    void this.saveIndex();
    return session;
  }

  /** 手机没指定目录(空或 "~")时,默认手机上次在这台 Mac 用过的项目;都没有才用主目录。 */
  private resolveCwd(requested: string): string {
    if (requested && requested !== "~") return path.resolve(expandHome(requested));
    const recent = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return recent?.cwd ?? os.homedir();
  }

  private async capabilities(): Promise<LinkResponse> {
    const upstream = await this.leoagent.request("GET", "/v1/capabilities");
    const legacy = upstream.status === 200 ? (record(upstream.body)["harnesses"] as unknown[] | undefined) ?? [] : [];
    return {
      status: 200,
      body: {
        object: "leoagent.capabilities",
        platform: "leoagent",
        version: VERSION,
        server: "leophoneagent",
        app_version: this.deps.appVersion,
        features: {
          harness_sessions: true,
          resumable_events: true,
          approval_events: true,
          session_steering: true,
          task_scope_approval: true,
          full_auto: true,
          session_digest: false,
          task_receipts: false,
          artifacts: false,
          exact_window: false,
        },
        harnesses: [{ key: ZCODE, name: "LeoPhoneAgent", executable: "LeoPhoneAgent" }, ...legacy],
      },
    };
  }

  private async list(): Promise<LinkResponse> {
    const ours = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => session.summary());
    const desktop = (await this.listDesktopTasks()).map((task) => ({
      session_id: task.taskId,
      harness: ZCODE,
      name: "LeoPhoneAgent",
      cwd: task.cwd,
      status: task.status,
      title: task.title,
      source: "desktop",
      created_at: task.createdAt / 1000,
      updated_at: task.updatedAt / 1000,
      seq: 0,
      waiting_for_approval: false,
      pending_approvals: [],
    }));
    ours.push(...desktop);
    const upstream = await this.leoagent.request("GET", "/harness/sessions");
    const theirs = upstream.status === 200 ? ((record(upstream.body)["sessions"] as unknown[] | undefined) ?? []) : [];
    return { status: 200, body: { sessions: [...ours, ...theirs] } };
  }

  private async create(req: LinkRequest): Promise<LinkResponse> {
    const body = record(req.body);
    const harness = String(body["harness"] ?? ZCODE) || ZCODE;
    const fullAuto = body["full_auto"] === true;
    if (harness !== ZCODE) {
      if (fullAuto) return error(400, "全自动只支持 LeoPhoneAgent 任务");
      return this.leoagent.request("POST", "/harness/sessions", req.body);
    }
    if (fullAuto && !mayUseFullAuto(req.caller)) return error(403, "认不出是哪台设备发来的,不能开全自动;把中继升级到 0.2 后再试");
    const cwd = this.resolveCwd(String(body["cwd"] ?? "").trim());
    const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
    const { taskService } = this.deps;
    let taskId: string;
    try {
      // 与上游机器人同一条路:先建 v4 草稿,再定模式(模式进 agent 会话的唯一咽喉),最后首发。
      taskId = (await taskService.createTask({ workspacePath: cwd, v4Create: true })).taskId;
      await taskService.setMode({ taskId, mode: fullAuto ? "yolo" : "build" });
    } catch (cause) {
      return error(502, `Mac 上建任务失败:${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const session = this.newSession(taskId, cwd, fullAuto ? "yolo" : "build");
    session.lastCaller = req.caller;
    this.sessions.set(taskId, session);
    try {
      await session.open();
    } catch (cause) {
      this.sessions.delete(taskId);
      await session.close().catch(() => undefined);
      return error(502, `Mac 上打开任务日志失败:${cause instanceof Error ? cause.message : String(cause)}`);
    }
    session.emit({ event: "session.created", harness: ZCODE, cwd, full_auto: fullAuto });
    if (prompt) {
      // 失败时 send() 已经写了 run.failed。
      await session.send(prompt, req.caller).catch(() => undefined);
    }
    void this.saveIndex();
    return { status: 202, body: { session_id: taskId, harness: ZCODE, status: session.status, full_auto: fullAuto } };
  }

  private async send(session: LinkSession, body: Record<string, unknown>, caller: Caller): Promise<LinkResponse> {
    const text = String(body["text"] ?? "");
    if (!text) return error(400, "text is required");
    if (typeof body["full_auto"] === "boolean") {
      const wanted = body["full_auto"];
      if (wanted && !mayUseFullAuto(caller)) return error(403, "认不出是哪台设备发来的,不能开全自动;把中继升级到 0.2 后再试");
      // "关"只把全自动任务切回先问我;计划、编辑这类别的模式不动(手机每条消息都会带开关状态)。
      const target = wanted ? "yolo" : session.isFullAuto ? "build" : null;
      if (target) {
        try {
          await session.setMode(target);
        } catch (cause) {
          return error(502, `切换模式失败:${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
    // 处在全自动(完全访问)的任务 —— 手机开的、Mac 桌面上自己设的、重启后认回来的 —— 不接受认不出身份的消息:
    // 否则谁拿到中继 0.1 的通道发一句话,就能让 Mac 免审批地跑命令。
    if (session.isFullAuto && !mayUseFullAuto(caller)) {
      return error(403, "这个任务在 Mac 上是全自动(完全访问)模式,认不出是哪台设备发来的消息不接;在 Mac 上把它切回「先问我」,或把中继升级到 0.2");
    }
    try {
      await session.send(text, caller);
    } catch (cause) {
      return error(409, cause instanceof Error ? cause.message : String(cause));
    }
    void this.saveIndex();
    return { status: 200, body: { ok: true, seq: session.seq } };
  }

  private async approve(session: LinkSession, body: Record<string, unknown>, caller: Caller): Promise<LinkResponse> {
    // 旧客户端可能回 "always":按「本任务都允许」处理,绝不当成永久放行。
    const rawChoice = String(body["choice"] ?? "").toLowerCase();
    const choice = rawChoice === "always" ? "session" : rawChoice;
    let approvalId = body["approval_id"] == null ? null : String(body["approval_id"]);
    if (!approvalId && session.pendingApprovals.size === 1) approvalId = [...session.pendingApprovals.keys()][0]!;
    if (!approvalId || !session.pendingApprovals.has(approvalId)) return error(409, "No such pending approval");
    if (!APPROVAL_CHOICES.includes(choice as ApprovalChoice)) {
      return error(400, `Invalid choice; expected one of: ${APPROVAL_CHOICES.join(", ")}`);
    }
    const result = await session.respond(approvalId, choice as ApprovalChoice, caller);
    if (result === "missing") return error(409, "No such pending approval");
    if (result === "forbidden") return error(403, "认不出是哪台设备,只能拒绝;请在 Mac 上批准,或把中继升级到 0.2");
    if (result === "undelivered") return error(502, "Approval could not be delivered to the task");
    return { status: 200, body: { ok: true, choice, approval_id: approvalId } };
  }

  /**
   * 手机「清理」:把任务从手机的列表里拿掉。只动 Leo Link 这一层 —— Mac 桌面上的任务和对话原样保留,
   * 在最近的项目里的话之后仍以 available 出现在 Mac 控制台。日志留着:将来再接管时编号接得上,手机的游标不乱。
   */
  private async archive(sessionId: string, pathname: string, body: unknown): Promise<LinkResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      if (this.desktopTasks.has(sessionId)) return { status: 200, body: { ok: true, archived: false } };
      return this.leoagent.request("POST", pathname, body);
    }
    if (session.status === "running" || session.status === "waiting_for_approval") {
      return error(409, "任务还在跑:先停止,再清理");
    }
    this.sessions.delete(sessionId);
    await session.close();
    await this.saveIndex();
    return { status: 200, body: { ok: true, archived: true } };
  }

  /** 手机关掉全自动:它发起、还在跑的全自动任务切回「先问我」。 */
  private async fullAutoOff(req: LinkRequest): Promise<LinkResponse> {
    if (record(req.body)["enabled"] !== false) return error(400, "只支持关闭:{\"enabled\": false}");
    const switched: string[] = [];
    for (const session of this.sessions.values()) {
      if (!session.isFullAuto) continue;
      const owner = session.lastCaller;
      if (req.caller.deviceId && owner?.deviceId && owner.deviceId !== req.caller.deviceId) continue;
      try {
        await session.setMode("build");
        switched.push(session.sessionId);
      } catch (cause) {
        // 切不动就停掉,宁可停也不能继续免审批地跑。
        this.deps.logger.warn("[leo/link] setMode build failed; stopping", { error: String(cause) });
        await session.stop().catch(() => undefined);
        switched.push(session.sessionId);
      }
    }
    if (switched.length > 0) void this.saveIndex();
    return { status: 200, body: { ok: true, sessions: switched } };
  }

  private pruneDone(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [id, entry] of this.done) {
      if (entry.at < cutoff) this.done.delete(id);
    }
  }
}
