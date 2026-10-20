/* eslint-disable max-lines -- LinkBridge is the single mobile command admission owner; transports delegate to this state machine. */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IZCodeTaskService } from "@zcode/services";
import type { ModelSelection, ZCodeTaskMode } from "@zcode/shared";
import type { LeoDeviceDescriptor } from "@zcode/shared/leo-device";

import { fetchDesktopTasks, type DesktopTask } from "./desktopTasks.js";
import type { HarnessEvent } from "./journal.js";
import { DirectGrants } from "./directGrants.js";
import { OperationReceipts } from "./operationReceipts.js";
import { LeoagentForwarder } from "./leoagentForward.js";
import { acpModelSelection, type AcpAgentId } from "@zcode/shared/acp";
import { LEOBOT_NO_MODEL_MESSAGE } from "../leobotModelSelection.js";
import type { AcpAuthState, AcpLoginFlows } from "@zcode/shared/acp-login";
import { ChangesError, fileDiff, revertChanges, workspaceChanges } from "./changes.js";
import {
  acpResumeHeld,
  defaultAcpSessionsPath,
  defaultClaudeProjectsDir,
  findClaudeSession,
  listClaudeSessions,
  readClaudeHistory,
  seedAcpResume,
  SESSION_UUID,
  type ExternalSession,
} from "./externalSessions.js";
import {
  deviceNotRecognized,
  error,
  expandHome,
  isLinkPath,
  LINK_MODES,
  linkMode,
  mayUseFullAuto,
  record,
  validSessionId,
} from "./linkPolicy.js";
import { resumeEnvelope } from "./resumeEnvelope.js";
import { APPROVAL_CHOICES, LinkSession, type ApprovalChoice, type Caller } from "./session.js";
import type { ScreenRequest } from "./screen/snapshot.js";
import type { ScreenSessionRequest } from "./screen/session.js";
import type { RelayE2E } from "./relayE2E.js";

export type LinkRequest = {
  method: string;
  path: string;
  body?: unknown;
  caller: Caller;
  requestId?: string;
  transport?: "direct" | "relay";
  /** [WP-50] 直连带过来的 If-None-Match(中继不转发请求头,走 if_none_match 查询参数)。 */
  ifNoneMatch?: string;
};
/** binary / headers 只有直连能用(看屏的 JPEG);中继只认 JSON body。 */
export type LinkResponse = {
  status: number;
  body: unknown;
  binary?: { data: Buffer; contentType: string };
  headers?: Record<string, string>;
};
type Logger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

export type LinkBridgeDeps = {
  device?: LeoDeviceDescriptor;
  directGrants?: DirectGrants;
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
  /** [WP-50] 看屏截图(docs/specs/leo-screen.md);没有就是 404。 */
  screen?: (req: ScreenRequest) => Promise<LinkResponse>;
  /** [WP-51] 看屏 R1 视频信令 /screen/session…;没有就是 404。 */
  screenSession?: (req: ScreenSessionRequest) => Promise<LinkResponse>;
  /** 本机 sshd 公钥(仅公钥),手机经已配对的加密通道读取后固定 SSH 身份;默认读 /etc/ssh。 */
  sshHostKeys?: () => Promise<string[]>;
  /** [WP-21] 本机的 ACP 外部 agent(含不可用的):手机端的 harness 列表与开会话都走它(LeoBot 运行时托管)。 */
  acpAgents?: () => ReadonlyArray<{
    id: AcpAgentId;
    name: string;
    harnessKey: string;
    available: boolean;
    cliPath?: string;
    unavailableReason?: string;
    loginCommand?: string;
  }>;
  /** [fix-remote] 外部 agent CLI 的版本(`--version`,带超时与缓存);没有就不报版本。 */
  acpAgentVersion?: (cliPath: string) => Promise<string | undefined>;
  /**
   * [fix-remote] LeoBot(zcode)任务用的模型:用户默认或第一个非 acp 的可用模型;null = 一个都没配。
   * 没有这个依赖时不传模型(旧行为,仅测试)。
   */
  zcodeModelSelection?: () => Promise<ModelSelection | null>;
  /** [fix-remote] 外部 agent 的远程登录（手机上点网页完成）；没有就是 404。 */
  agentLogin?: { state: (id: AcpAgentId) => AcpAuthState; flows: AcpLoginFlows };
  /** [fix-remote] 手机 SSH 兜底的目标（tailnet 名 + 用户名），capabilities 里广播。 */
  sshTarget?: () => Promise<{ host: string; user: string; fqdn?: string } | null>;
  /**
   * [WP-23] 旧的 leoagent(Python)harness 转发,默认关:ACP 接管手机开 Claude / Codex 会话后不再转发。
   * 打开方式:~/.leoagent/link.json 的 {"harness": {"legacy": true}} 或 LEO_HARNESS_LEGACY=1(harness.py 下个版本删)。
   */
  legacyHarness?: () => boolean;
  /** [takeover] Claude Code 的会话目录(默认 ~/.claude/projects);测试注入临时目录。 */
  claudeProjectsDir?: string;
  /** [takeover] CLI 的 ACP 会话映射文件(默认 $ZCODE_HOME/cli/acp-sessions.json)。 */
  acpSessionsPath?: string;
  /** [e2e] 经中继的端到端加密(docs/specs/leo-link-e2e.md);没有就不认 /e2e,手机退回明文。 */
  e2e?: RelayE2E;
};

function authSummary(state: AcpAuthState): { logged_in: boolean | null; method?: string; login_kind: string } {
  return { logged_in: state.logged_in, login_kind: state.login_kind, ...(state.method ? { method: state.method } : {}) };
}

/** [E5] 手机侧会话 id(可选):只当不透明标签,随审批 / 终态推送带回手机。 */
function phoneSessionIdOf(body: Record<string, unknown>): string | undefined {
  const value = body["phone_session_id"];
  if (typeof value !== "string") return undefined;
  return value.trim().slice(0, 200) || undefined;
}

/** 只返回看起来像 OpenSSH 公钥行的内容;私钥文件名不以 .pub 结尾,不会被读。 */
export async function readSSHHostKeys(dir = "/etc/ssh"): Promise<string[]> {
  const keys: string[] = [];
  for (const name of ["ssh_host_ed25519_key.pub", "ssh_host_ecdsa_key.pub", "ssh_host_rsa_key.pub"]) {
    try {
      const line = (await fsp.readFile(path.join(dir, name), "utf8")).trim();
      const [algorithm, publicKey] = line.split(/\s+/);
      // 显式检查字段存在，兼容严格索引类型检查并保留畸形公钥拒绝规则。
      if (algorithm && publicKey && /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(algorithm) && /^[A-Za-z0-9+/=]+$/.test(publicKey)) {
        keys.push(`${algorithm} ${publicKey}`);
      }
    } catch {
      // 没有该算法的主机密钥很正常。
    }
  }
  return keys;
}

const VERSION = "0.4.0";
const ZCODE = "zcode";
/** [takeover] 接管终端会话用的 ACP agent。 */
const CLAUDE_ACP = "claude-code";
/** 重启后认回的任务数上限;更老的手机上也早就翻不到了。 */
const INDEX_LIMIT = 50;

/**
 * [leo-link] 手机协议 v0.4 在新 Mac 上的实现。中继帧在进程内交到这里,
 * 不经本机 38473 端口。ZCode 任务由这里直接驱动;claude / codex / grok 转给本机 leoagent。
 */
export class LinkBridge {
  private readonly sessions = new Map<string, LinkSession>();
  private readonly receipts: OperationReceipts;
  /** 正在接管的桌面任务:同一个任务同时来两个请求时只接一次(否则两份日志写同一个文件、订阅泄漏)。 */
  private readonly adopting = new Map<string, Promise<LinkSession | null>>();
  /**
   * 连着的是中继 0.2(注册回执带 version):它会给每个请求附上调用方,这时认不出身份的请求一律按旧版设备对待。
   * 中继 0.1 不附调用方,所有请求都是 unknown —— 那时不能收紧,否则连你的 iPhone 也批不了命令。
   */
  strictCallers = false;
  /** [takeover] 正在接管的终端会话:同一个会话同时来两次只开一个任务。 */
  private readonly takingOver = new Map<string, Promise<LinkResponse>>();
  /** 最近一次列出的桌面任务;接管时按它找工作区。 */
  private desktopTasks = new Map<string, DesktopTask>();

  private readonly leoagent: LeoagentForwarder;
  /** 认回任务期间不写任务表:这时只认回了一部分,写下去再赶上崩溃,没认回的那些就丢了。 */
  private restoring = false;
  private saveWanted = false;

  constructor(private readonly deps: LinkBridgeDeps) {
    this.leoagent = new LeoagentForwarder(deps.leoagent);
    this.receipts = new OperationReceipts(path.join(deps.journalDir, "operations"));
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
        void this.saveIndex().catch(() => undefined);
      }
    }
  }

  private async restoreFromIndex(): Promise<void> {
    let entries: Record<string, unknown>[] = [];
    try {
      entries = JSON.parse(await fsp.readFile(this.indexPath(), "utf8")) as Record<
        string,
        unknown
      >[];
    } catch {
      return;
    }
    // [fix] 以前逐个串行 open(每个都整份扫日志):任务一多 Mac 重启后手机要等很久。现在只读日志尾部、并发认回。
    const pending: LinkSession[] = [];
    for (const entry of Array.isArray(entries) ? entries.slice(0, INDEX_LIMIT) : []) {
      const taskId = typeof entry["task_id"] === "string" ? entry["task_id"] : "";
      const cwd = typeof entry["cwd"] === "string" ? entry["cwd"] : "";
      if (!taskId || !cwd || this.sessions.has(taskId) || pending.some((s) => s.sessionId === taskId)) continue;
      const session = this.newSession(taskId, cwd, linkMode(entry["mode"]) ?? "build");
      session.title = typeof entry["title"] === "string" ? entry["title"] : "";
      if (typeof entry["harness"] === "string") session.harness = entry["harness"];
      if (typeof entry["harness_name"] === "string") session.harnessName = entry["harness_name"];
      if (typeof entry["phone_session_id"] === "string") session.phoneSessionId = entry["phone_session_id"];
      if (typeof entry["external_session_id"] === "string") session.externalSessionId = entry["external_session_id"];
      session.resumeFailed = entry["resume_failed"] === true;
      if (session.externalSessionId && !session.resumeFailed) this.armResumeCheck(session);
      if (typeof entry["created_at"] === "number") session.createdAt = entry["created_at"];
      // 最后活动时间从创建时间起算,open() 再按日志最后一条事件往后推。以前这里取的是「现在」:
      // 每次 Mac 重启,手机上的旧任务都像刚动过,一直占着首页「进行中」。
      session.updatedAt = session.createdAt;
      session.needsResume = true;
      pending.push(session);
    }
    await Promise.all(
      pending.map(async (session) => {
        try {
          await session.open();
          this.sessions.set(session.sessionId, session);
        } catch (cause) {
          this.deps.logger.warn("[leo/link] restore failed", { taskId: session.sessionId, error: String(cause) });
        }
      }),
    );
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
    this.saving = this.saving.catch(() => undefined).then(() => this.writeIndex());
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
      throw cause;
    }
  }

  private newSession(taskId: string, cwd: string, mode: ZCodeTaskMode): LinkSession {
    return new LinkSession(
      { taskId, cwd, mode },
      {
        taskService: this.deps.taskService,
        journalDir: this.deps.journalDir,
        push: this.deps.push,
        logger: this.deps.logger,
        strictCallers: () => this.strictCallers,
        onModeChanged: () => void this.saveIndex().catch(() => undefined),
      },
    );
  }

  async handle(req: LinkRequest): Promise<LinkResponse> {
    const url = new URL(req.path, "http://link.invalid");
    if (this.deps.directGrants?.isRevoked(req.caller)) return error(403, "设备授权已撤销");
    const method = req.method.toUpperCase();
    // [e2e] 中继只看到密文信封;解开后按内层请求重新走一遍本函数(白名单、回执都照旧),调用方仍是中继鉴过权的那个。
    if (url.pathname === "/e2e" && method === "POST" && this.deps.e2e)
      return this.deps.e2e.handle(req.body, (inner) => this.handle({ ...inner, caller: req.caller, ...(req.transport ? { transport: req.transport } : {}) }));
    if (url.pathname === "/direct-grants" && method === "POST") {
      if (req.transport === "direct" || !req.caller.deviceId || req.caller.kind === "unknown")
        return error(403, "请先通过中继或本机配对授权");
      if (
        !this.deps.directGrants ||
        !this.deps.device?.endpoints.some((endpoint) => endpoint.kind === "direct")
      )
        return error(503, "本机直连尚未配置");
      return {
        status: 200,
        body: { device: this.deps.device, grant: await this.deps.directGrants.issue(req.caller) },
      };
    }
    const operation = /^\/operations\/([a-zA-Z0-9_.:-]{1,200})$/.exec(url.pathname);
    if (operation && method === "GET")
      return this.receipts.status({ ...req, requestId: operation[1] });
    if (!isLinkPath(url.pathname)) return error(404, "这个接口不对手机开放");
    // [WP-51] 看屏信令不进操作回执:回执会把 SDP(含 ICE 口令、DTLS 指纹)落盘,重放旧答案也没有意义。
    // [fix-remote] 登录流程也不进回执：回填的授权码 / API key 不能落盘，重放旧的登录结果也没意义。
    if (method !== "POST" || !req.requestId || url.pathname.startsWith("/screen/") || url.pathname.startsWith("/agents/"))
      return this.route(method, url, req);
    if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(req.requestId)) return error(400, "操作编号格式不正确");
    return this.receipts.run(
      req,
      () => this.route(method, url, req),
      (checkpoint) => this.recoverOperation(req, checkpoint),
    );
  }

  private async recoverOperation(
    req: LinkRequest,
    checkpoint: Record<string, unknown>,
  ): Promise<LinkResponse | null> {
    if (
      req.path === "/harness/sessions" &&
      ["creating", "ready", "sending"].includes(String(checkpoint["stage"]))
    ) {
      return this.create(req, checkpoint);
    }
    if (checkpoint["stage"] === "sending" && typeof checkpoint["taskId"] === "string") {
      const session = this.sessions.get(checkpoint["taskId"]);
      if (!session) return null;
      const commandId = this.receipts.operationId(req, "send");
      const ack = await this.deps.taskService.queryOperation({
        workspacePath: session.cwd,
        taskId: session.sessionId,
        operationId: commandId,
      });
      if (ack && ["accepted", "duplicate", "noop"].includes(ack.status))
        return {
          status: 202,
          body: { ok: true, session_id: session.sessionId, status: session.status },
        };
      if (ack) return error(409, ack.message ?? "该输入在重启时已被撤销，请核对任务后重新发送");
      // 同一个 V4 commandId 重新交回唯一 admission owner，由它查重；不新建任务。
      return this.send(session, record(req.body), req.caller, req);
    }
    return null;
  }

  async revokeCallers(deviceIds: string[]): Promise<void> {
    await this.deps.directGrants?.revokeMany(deviceIds);
  }

  /** `/harness/sessions/:id/events` 的 SSE 数据行(不含 `data: ` 前缀)。 */
  async stream(
    req: LinkRequest,
    write: (data: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.deps.directGrants?.isRevoked(req.caller)) return;
    const emit = (data: string) => {
      if (!signal.aborted && !this.deps.directGrants?.isRevoked(req.caller)) write(data);
    };
    const url = new URL(req.path, "http://link.invalid");
    if (url.pathname === "/e2e/events" && this.deps.e2e)
      return this.deps.e2e.stream(
        url.searchParams,
        (inner, sealed) => this.stream({ ...inner, caller: req.caller, ...(req.transport ? { transport: req.transport } : {}) }, sealed, signal),
        emit,
      );
    const match = /^\/harness\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (!match) return;
    const sessionId = decodeURIComponent(match[1]!);
    if (!validSessionId(sessionId)) return;
    const session = this.sessions.get(sessionId) ?? (await this.adoptDesktopTask(sessionId));
    if (!session) {
      if (this.legacyEnabled()) await this.leoagent.stream(url.pathname + url.search, emit, signal);
      return;
    }
    const parsed = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    const after = Number.isNaN(parsed) ? 0 : parsed;
    emit(JSON.stringify(resumeEnvelope(after, 0)));
    try {
      for await (const event of session.subscribe(after, {
        signal,
        journalStatus: url.searchParams.get("journal_status") === "1",
      })) {
        if (this.deps.directGrants?.isRevoked(req.caller)) break;
        emit(JSON.stringify(event));
      }
    } catch {
      // 手机走了是常态;任务照跑,日志照长,下次按 seq 续传。
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    // mode_update/接管会排队写sessions.json；先排空索引再释放session，
    // 否则close返回后仍会创建文件，且晚到写入可能把已清空的Map保存成空索引。
    await this.saving;
    this.sessions.clear();
  }

  // -- 路由 -------------------------------------------------------------------

  private async route(method: string, url: URL, req: LinkRequest): Promise<LinkResponse> {
    const pathname = url.pathname;
    if (pathname === "/health" && method === "GET") {
      return {
        status: 200,
        body: {
          status: "ok",
          platform: "leoagent",
          version: VERSION,
          server: "leophoneagent",
          app_version: this.deps.appVersion,
        },
      };
    }
    if (pathname === "/v1/capabilities" && method === "GET") return this.capabilities();
    if (pathname === "/v1/grok/token" && method === "GET")
      return this.leoagent.request("GET", url.pathname);
    if (pathname === "/harness/full-auto" && method === "POST") return this.fullAutoOff(req);
    if (pathname === "/screen/snapshot") {
      if (method !== "GET") return error(405, "Method not allowed");
      if (!this.deps.screen) return error(404, "这台 Mac 不支持看屏");
      return this.deps.screen({
        caller: req.caller,
        transport: req.transport ?? "relay",
        query: url.searchParams,
        ...(req.ifNoneMatch ? { ifNoneMatch: req.ifNoneMatch } : {}),
      });
    }
    if (pathname === "/screen/session" || pathname.startsWith("/screen/session/")) {
      if (!this.deps.screenSession) return error(404, "这台 Mac 不支持视频看屏");
      return this.deps.screenSession({
        method,
        subpath: pathname.slice("/screen/session".length),
        caller: req.caller,
        body: req.body,
      });
    }
    if (pathname.startsWith("/agents/")) return this.agentLogin(method, pathname, req);
    if (pathname === "/harness/sessions") {
      if (method === "GET") return this.list();
      if (method === "POST") return this.createOnce(req);
      return error(405, "Method not allowed");
    }
    if (pathname === "/harness/external-sessions") {
      if (method !== "GET") return error(405, "Method not allowed");
      return this.externalSessions();
    }
    const panel = /^\/harness\/sessions\/([^/]+)\/(mode|changes|diff|revert)$/.exec(pathname);
    if (panel) return this.sessionPanel(method, panel[2]!, decodeURIComponent(panel[1]!), url, req);
    const match = /^\/harness\/sessions\/([^/]+)\/(send|approval|stop|archive)$/.exec(pathname);
    if (!match || method !== "POST") return error(405, "Method not allowed");
    const sessionId = decodeURIComponent(match[1]!);
    if (!validSessionId(sessionId)) return error(400, "会话 id 不合法");
    // 清理不接管桌面任务:没接过来的本来就不在手机的「进行中」里。
    if (match[2] === "archive") return this.archive(sessionId, url.pathname, req.body);
    const session = this.sessions.get(sessionId) ?? (await this.adoptDesktopTask(sessionId));
    if (!session) {
      if (this.legacyEnabled()) return this.leoagent.request("POST", url.pathname, req.body, req.caller);
      return error(404, "这台 Mac 上没有这个任务");
    }
    const body = record(req.body);
    switch (match[2]) {
      case "send":
        return this.send(session, body, req.caller, req);
      case "approval":
        return this.approve(session, body, req.caller);
      default:
        await session.stop();
        return { status: 200, body: { ok: true, status: session.status } };
    }
  }

  /** 权限模式与改动面板(docs/specs/leo-link-changes.md):只对这台 Mac 上的 LeoBot 任务,不转发旧 leoagent。 */
  private async sessionPanel(
    method: string,
    action: string,
    sessionId: string,
    url: URL,
    req: LinkRequest,
  ): Promise<LinkResponse> {
    const wanted = action === "changes" || action === "diff" ? "GET" : "POST";
    if (method !== wanted) return error(405, "Method not allowed");
    if (!validSessionId(sessionId)) return error(400, "会话 id 不合法");
    const session = this.sessions.get(sessionId) ?? (await this.adoptDesktopTask(sessionId));
    if (!session) return error(404, "这台 Mac 上没有这个任务");
    const body = record(req.body);
    try {
      switch (action) {
        case "mode":
          return await this.setMode(session, body, req.caller);
        case "changes":
          return { status: 200, body: await workspaceChanges(session.cwd, session.sessionId) };
        case "diff":
          return {
            status: 200,
            body: await fileDiff(
              session.cwd,
              session.sessionId,
              url.searchParams.get("path"),
              url.searchParams.get("checkpoint") || undefined,
            ),
          };
        default:
          return await this.revert(session, body, req.caller);
      }
    } catch (cause) {
      if (cause instanceof ChangesError) return error(cause.status, cause.message);
      this.deps.logger.warn("[leo/link] session panel failed", { action, error: String(cause) });
      return error(502, `Mac 上处理失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private async setMode(session: LinkSession, body: Record<string, unknown>, caller: Caller): Promise<LinkResponse> {
    const mode = linkMode(body["mode"]);
    if (!mode) return error(400, `mode 只能是 ${LINK_MODES.join(" / ")}`);
    if (mode === "yolo" && !mayUseFullAuto(caller))
      return deviceNotRecognized("认不出是哪台设备发来的，不能开全自动；按步骤在 Mac 上处理后再试");
    await session.setMode(mode);
    void this.saveIndex().catch(() => undefined);
    return { status: 200, body: { mode: session.mode } };
  }

  /** 回滚会删改文件:任务在跑时不动(agent 正在写);认不出身份的调用方(中继 0.2 下)不能回滚。 */
  private async revert(session: LinkSession, body: Record<string, unknown>, caller: Caller): Promise<LinkResponse> {
    if (this.strictCallers && caller.kind === "unknown")
      return deviceNotRecognized("认不出是哪台设备，不能回滚这台 Mac 上的文件；按步骤在 Mac 上处理后再试");
    if (session.status === "running" || session.status === "waiting_for_approval")
      return error(409, "任务还在跑：先停止，再回滚");
    const checkpoint = body["checkpoint"];
    const paths = body["paths"];
    if (checkpoint !== undefined && checkpoint !== null && typeof checkpoint !== "string")
      return error(400, "checkpoint 必须是字符串");
    if (paths !== undefined && paths !== null && !Array.isArray(paths)) return error(400, "paths 必须是数组");
    const result = await revertChanges(session.cwd, session.sessionId, {
      ...(typeof checkpoint === "string" ? { checkpoint } : {}),
      ...(Array.isArray(paths) ? { paths } : {}),
    });
    return { status: 200, body: result };
  }

  /** Mac 最近打开的项目里的任务(手机自己开的已经在 sessions 里,不重复列)。读不到就当没有。 */
  private async listDesktopTasks(): Promise<DesktopTask[]> {
    const workspaces = (await this.deps.recentWorkspaces?.().catch(() => [])) ?? [];
    try {
      const tasks = (await fetchDesktopTasks(this.deps.taskService, workspaces)).filter(
        (task) => !this.sessions.has(task.taskId),
      );
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
      session.emit({
        event: "session.note",
        text: `接上了 Mac 上的任务「${task.title || "未命名"}」：之前的对话在 Mac 上，这里从现在开始同步。`,
      });
    }
    void this.saveIndex().catch(() => undefined);
    return session;
  }

  /** 手机没指定目录(空或 "~")时,默认手机上次在这台 Mac 用过的项目;都没有才用主目录。 */
  private resolveCwd(requested: string): string {
    if (requested && requested !== "~") return path.resolve(expandHome(requested));
    const recent = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return recent?.cwd ?? os.homedir();
  }

  private legacyEnabled(): boolean {
    return this.deps.legacyHarness?.() ?? false;
  }

  private availableAcpAgents() {
    return (this.deps.acpAgents?.() ?? []).filter((agent) => agent.available);
  }

  /** [fix-remote] LeoBot 任务的模型;undefined = 不指定(没有依赖,或读取失败时交给内核默认,内核默认也已排除 acp)。 */
  private async zcodeModel(): Promise<ModelSelection | null | undefined> {
    if (!this.deps.zcodeModelSelection) return undefined;
    try {
      return await this.deps.zcodeModelSelection();
    } catch (cause) {
      this.deps.logger.warn("[leo/link] resolving LeoBot model failed", { error: String(cause) });
      return undefined;
    }
  }

  /**
   * [fix-remote] 手机上登录 Mac 上的外部 agent。读状态任何已配对通道都行；开始 / 回填 / 取消会改 Mac 上的凭据，
   * 只接受认得出的设备（与全自动同级）。
   */
  private agentLogin(method: string, pathname: string, req: LinkRequest): LinkResponse {
    const login = this.deps.agentLogin;
    if (!login) return error(404, "这台 Mac 不支持远程登录外部 agent");
    const match = /^\/agents\/([^/]+)\/(auth|login)(?:\/([^/]+)(?:\/(code|cancel))?)?$/.exec(pathname);
    const key = decodeURIComponent(match?.[1] ?? "");
    const agent = (this.deps.acpAgents?.() ?? []).find((candidate) => candidate.harnessKey === key || candidate.id === key);
    if (!match || !agent) return error(404, `这台 Mac 上没有「${key}」`);
    if (match[2] === "auth") {
      if (method !== "GET") return error(405, "Method not allowed");
      return { status: 200, body: login.state(agent.id) };
    }
    const flowId = match[3];
    if (method === "GET" && flowId && !match[4]) {
      const view = login.flows.get(flowId);
      return view && view.agent === agent.id ? { status: 200, body: view } : error(404, "没有这个登录流程");
    }
    if (!mayUseFullAuto(req.caller)) {
      return deviceNotRecognized("认不出是哪台设备，不能在这台 Mac 上登录外部 agent；按步骤在 Mac 上处理后再试");
    }
    if (method === "POST" && !flowId) {
      if (!agent.available) return error(409, `这台 Mac 上的「${agent.name}」用不了：${agent.unavailableReason ?? "启动不了"}`);
      const provider = record(req.body)["provider"];
      return {
        status: 202,
        body: login.flows.start(agent.id, typeof provider === "string" && /^[a-z0-9_-]{1,40}$/.test(provider) ? { provider } : {}),
      };
    }
    const view = flowId ? login.flows.get(flowId) : undefined;
    if (!view || view.agent !== agent.id) return error(404, "没有这个登录流程");
    if ((method === "POST" && match[4] === "cancel") || (method === "DELETE" && !match[4])) {
      return { status: 200, body: login.flows.cancel(flowId!) };
    }
    if (method === "POST" && match[4] === "code") {
      const code = record(req.body)["code"];
      if (typeof code !== "string" || !code.trim() || code.length > 4096) return error(400, "code is required");
      // 同步回填（API key 立即写盘，授权码写进伪终端）；结果按轮询看。
      void login.flows.submit(flowId!, code);
      return { status: 202, body: { ...view, status: view.kind === "api_key" ? view.status : "verifying" } };
    }
    return error(405, "Method not allowed");
  }

  private async sshTargetField(): Promise<{ ssh?: { host: string; user: string; fqdn?: string } }> {
    const target = await this.deps.sshTarget?.().catch(() => null);
    return target ? { ssh: target } : {};
  }

  private async capabilities(): Promise<LinkResponse> {
    // [fix-remote] 列出全部外部 agent(含不可用的,带原因),手机据此灰显并说明;可用与否以这里为准。
    const acp = await Promise.all(
      (this.deps.acpAgents?.() ?? []).map(async (agent) => {
        const version =
          agent.cliPath && this.deps.acpAgentVersion
            ? await this.deps.acpAgentVersion(agent.cliPath).catch(() => undefined)
            : undefined;
        return {
          key: agent.harnessKey,
          name: agent.name,
          executable: agent.name,
          runtime: "acp",
          available: agent.available,
          ...(agent.cliPath ? { cli_path: agent.cliPath } : {}),
          ...(version ? { version } : {}),
          ...(agent.available ? {} : { unavailable_reason: agent.unavailableReason ?? "这台 Mac 上启动不了" }),
          ...(agent.loginCommand ? { login_command: agent.loginCommand } : {}),
          ...(this.deps.agentLogin && agent.available ? { auth: authSummary(this.deps.agentLogin.state(agent.id)) } : {}),
        };
      }),
    );
    const zcodeModel = await this.zcodeModel();
    let legacy: unknown[] = [];
    if (this.legacyEnabled()) {
      const upstream = await this.leoagent.request("GET", "/v1/capabilities");
      const taken = new Set(acp.map((agent) => agent.key));
      legacy =
        upstream.status === 200
          ? (((record(upstream.body)["harnesses"] as unknown[] | undefined) ?? []).filter(
              (entry) => !taken.has(String(record(entry)["key"] ?? "")),
            ))
          : [];
    }
    return {
      status: 200,
      body: {
        object: "leoagent.capabilities",
        platform: "leoagent",
        version: VERSION,
        server: "leophoneagent",
        app_version: this.deps.appVersion,
        device: this.deps.device,
        // [e2e] 手机只在直连或扫码时固定它;经中继拿到的只作首次信任(见 spec)。
        ...(this.deps.e2e ? { relay_e2e: { v: 1, public_key: this.deps.e2e.publicKeyText } } : {}),
        ssh_host_keys: await (this.deps.sshHostKeys ?? readSSHHostKeys)(),
        ...(await this.sshTargetField()),
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
          // [WP-50/51] 看屏:截图 / WebRTC 视频(各自还受 Mac 上的开关约束,见 docs/specs/leo-screen.md)。
          screen_snapshot: Boolean(this.deps.screen),
          screen_session: Boolean(this.deps.screenSession),
          // [fix-remote] 手机上登录 Mac 上的外部 agent（/agents/<key>/login）。
          agent_login: Boolean(this.deps.agentLogin),
          // [takeover] 接管 Mac 终端里的 Claude Code 会话(/harness/external-sessions)。
          external_sessions: true,
          relay_e2e: Boolean(this.deps.e2e),
        },
        harnesses: [
          {
            key: ZCODE,
            name: "LeoBot",
            executable: "LeoBot",
            runtime: "zcode",
            available: zcodeModel !== null,
            ...(zcodeModel === null ? { unavailable_reason: LEOBOT_NO_MODEL_MESSAGE } : {}),
          },
          ...acp,
          ...legacy,
        ],
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
      name: "LeoBot",
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
    let theirs: unknown[] = [];
    if (this.legacyEnabled()) {
      const upstream = await this.leoagent.request("GET", "/harness/sessions");
      theirs =
        upstream.status === 200
          ? ((record(upstream.body)["sessions"] as unknown[] | undefined) ?? [])
          : [];
    }
    return { status: 200, body: { sessions: [...ours, ...theirs] } };
  }

  private async create(
    req: LinkRequest,
    checkpoint?: Record<string, unknown>,
  ): Promise<LinkResponse> {
    const body = record(req.body);
    // [takeover] 接管终端里的 Claude 会话:还是一个 claude(ACP)任务,cwd 用会话自己的,第一轮 session/load 续上。
    let takeover: ExternalSession | undefined;
    if (body["resume_external"] != null) {
      const resolved = await this.resolveTakeover(record(body["resume_external"]));
      if (!("file" in resolved)) return resolved;
      takeover = resolved;
    }
    const harness = takeover ? CLAUDE_ACP : String(body["harness"] ?? ZCODE) || ZCODE;
    // 显式的 mode 优先于 full_auto 的映射(开 → yolo,关 → build)。
    const requestedMode = body["mode"] == null ? undefined : linkMode(body["mode"]);
    if (body["mode"] != null && !requestedMode) return error(400, `mode 只能是 ${LINK_MODES.join(" / ")}`);
    const mode: ZCodeTaskMode = requestedMode ?? (body["full_auto"] === true ? "yolo" : "build");
    const fullAuto = mode === "yolo";
    if (fullAuto && !mayUseFullAuto(req.caller))
      return deviceNotRecognized("认不出是哪台设备发来的，不能开全自动；按步骤在 Mac 上处理后再试");
    // [WP-21] claude / codex / gemini / opencode 走 ACP:仍是一个 LeoBot 任务,模型选择是对应的外部 agent。
    const acpAgent =
      harness === ZCODE
        ? undefined
        : this.availableAcpAgents().find((agent) => agent.harnessKey === harness || agent.id === harness);
    if (harness !== ZCODE && !acpAgent) {
      // [WP-23] 旧 leoagent harness 只在显式打开 legacy 时转发。
      if (this.legacyEnabled())
        return this.leoagent.request("POST", "/harness/sessions", req.body, req.caller);
      // [fix-remote] 认得这个 agent 但本机启动不了:把原因原样告诉手机(没装在哪、怎么装)。
      const known = (this.deps.acpAgents?.() ?? []).find(
        (agent) => agent.harnessKey === harness || agent.id === harness,
      );
      return error(
        400,
        known
          ? `这台 Mac 上的「${known.name}」用不了：${known.unavailableReason ?? "启动不了"}`
          : `这台 Mac 上没有可用的「${harness}」`,
      );
    }
    // [fix-remote] LeoBot 任务显式选非 acp 模型(新建或按 ready 检查点重建 draft 时才需要)。
    // 不传模型时内核取 registry 第一个,没配个人供应商的 Mac 上会落到 acp/claude-code。
    const needsCreate = typeof checkpoint?.["taskId"] !== "string" || checkpoint["stage"] === "ready";
    let modelSelection: ModelSelection | undefined = acpAgent ? acpModelSelection(acpAgent.id) : undefined;
    if (!acpAgent && needsCreate) {
      const selected = await this.zcodeModel();
      if (selected === null) return error(409, LEOBOT_NO_MODEL_MESSAGE);
      modelSelection = selected;
    }
    const phoneSessionId = phoneSessionIdOf(body);
    const cwd =
      typeof checkpoint?.["cwd"] === "string"
        ? checkpoint["cwd"]
        : (takeover?.cwd ?? this.resolveCwd(String(body["cwd"] ?? "").trim()));
    const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
    const { taskService } = this.deps;
    let taskId = typeof checkpoint?.["taskId"] === "string" ? checkpoint["taskId"] : "";
    if (taskId && checkpoint?.["stage"] === "ready") {
      // ready 在任何 send admission 之前落盘。CLI 重启会丢弃空 draft，可复用仍存在的 draft 或安全重建。
      const restored = await taskService.createTask({ workspacePath: cwd, draftSessionId: taskId, v4Create: true, mode, ...(modelSelection ? { modelSelection } : {}), operationId: this.receipts.operationId(req, "create") });
      if (restored.taskId !== taskId) {
        await this.sessions.get(taskId)?.close();
        this.sessions.delete(taskId);
        taskId = restored.taskId;
      }
      await taskService.setMode({ taskId, mode });
    }
    if (!taskId) {
      if (req.requestId) await this.receipts.checkpoint(req, { stage: "creating", cwd });
      try {
        // 空 draft 不执行输入；稳定 create ID 在活着的 CLI 中查重，重启后不存在的 draft 可安全重建。
        taskId = (
          await taskService.createTask({
            workspacePath: cwd,
            v4Create: true,
            mode,
            ...(modelSelection ? { modelSelection } : {}),
            ...(req.requestId ? { operationId: this.receipts.operationId(req, "create") } : {}),
          })
        ).taskId;
        if (req.requestId) await this.receipts.checkpoint(req, { stage: "ready", cwd, taskId });
        await taskService.setMode({ taskId, mode });
      } catch (cause) {
        if (req.requestId) throw cause;
        return error(
          502,
          `Mac 上建任务失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    let session = this.sessions.get(taskId);
    if (!session) {
      session = this.newSession(taskId, cwd, mode);
      if (acpAgent) {
        session.harness = acpAgent.harnessKey;
        session.harnessName = acpAgent.name;
      }
      session.lastCaller = req.caller;
      if (takeover) {
        session.externalSessionId = takeover.id;
        session.title = takeover.title || path.basename(cwd);
      }
      this.sessions.set(taskId, session);
      try {
        // 映射必须在第一轮之前写好:否则 CLI 给这个任务开的是一个空白的新 Claude 会话。
        if (takeover) await seedAcpResume(this.deps.acpSessionsPath ?? defaultAcpSessionsPath(), taskId, takeover.id);
        await session.open();
      } catch (cause) {
        this.sessions.delete(taskId);
        await session.close().catch(() => undefined);
        return error(
          502,
          `Mac 上打开任务${takeover ? "（接管终端会话）" : "日志"}失败：${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      session.emit({ event: "session.created", harness: session.harness, cwd, full_auto: fullAuto, mode });
      if (takeover) await this.replayExternal(session, takeover);
    }
    if (phoneSessionId) session.phoneSessionId = phoneSessionId;
    // taskId 回执与会话索引都在首发之前落盘，崩溃后不得再次创建另一条任务。
    await this.saveIndex();
    if (req.requestId && checkpoint?.["stage"] !== "sending")
      await this.receipts.checkpoint(req, { stage: "ready", cwd, taskId });
    if (prompt) {
      const operationId = req.requestId ? this.receipts.operationId(req, "send") : undefined;
      const ack =
        checkpoint?.["stage"] === "sending" && operationId
          ? await taskService.queryOperation({ workspacePath: cwd, taskId, operationId })
          : null;
      if (ack && !["accepted", "duplicate", "noop"].includes(ack.status))
        return error(409, ack.message ?? "该输入在重启时已被撤销");
      if (!ack) {
        if (req.requestId) await this.receipts.checkpoint(req, { stage: "sending", cwd, taskId });
        await session.send(prompt, req.caller, operationId).catch((cause: unknown) => {
          if (req.requestId) throw cause;
        });
      }
    }
    await this.saveIndex();
    return {
      status: 202,
      body: {
        session_id: taskId,
        harness: session.harness,
        status: session.status,
        full_auto: fullAuto,
        mode: session.mode,
        ...(takeover ? { ...this.takeoverFields(session), ...(takeover.running ? { warning: "terminal_running" } : {}) } : {}),
      },
    };
  }

  // -- [takeover] 接管 Mac 终端里的 Claude Code 会话(docs/specs/leo-link-takeover.md) ----------------

  /** 最近的终端 Claude 会话;已被接管的带上对应的 LeoBot 任务 id。 */
  private async externalSessions(): Promise<LinkResponse> {
    const listed = await listClaudeSessions(this.deps.claudeProjectsDir ?? defaultClaudeProjectsDir());
    const taken = new Map([...this.sessions.values()].filter((s) => s.externalSessionId).map((s) => [s.externalSessionId!, s.sessionId]));
    return {
      status: 200,
      body: {
        sessions: listed.map(({ file: _file, ...session }) => ({
          ...session,
          ...(taken.has(session.id) ? { leobot_session_id: taken.get(session.id) } : {}),
        })),
      },
    };
  }

  /** 同一个外部会话同时来两次创建(手机连点、重试)只开一个任务。 */
  private createOnce(req: LinkRequest): Promise<LinkResponse> {
    const external = record(record(req.body)["resume_external"])["session_id"];
    if (typeof external !== "string") return this.create(req);
    const inFlight = this.takingOver.get(external);
    if (inFlight) return inFlight;
    const run = this.create(req).finally(() => this.takingOver.delete(external));
    this.takingOver.set(external, run);
    return run;
  }

  /** 校验并找到要接管的会话;已接管过的直接回那个任务(202,reused)。 */
  private async resolveTakeover(spec: Record<string, unknown>): Promise<ExternalSession | LinkResponse> {
    if (spec["agent"] !== "claude") return error(501, "目前只能接管 Claude Code 的会话");
    const id = spec["session_id"];
    if (typeof id !== "string" || !SESSION_UUID.test(id)) return error(400, "session_id 必须是 Claude Code 的会话 id（uuid）");
    const existing = [...this.sessions.values()].find((session) => session.externalSessionId === id);
    if (existing) {
      return {
        status: 202,
        body: {
          session_id: existing.sessionId,
          harness: existing.harness,
          status: existing.status,
          full_auto: existing.isFullAuto,
          mode: existing.mode,
          reused: true,
          ...this.takeoverFields(existing),
        },
      };
    }
    if (!this.availableAcpAgents().some((agent) => agent.id === CLAUDE_ACP)) {
      const known = (this.deps.acpAgents?.() ?? []).find((agent) => agent.id === CLAUDE_ACP);
      return error(409, `这台 Mac 上的 Claude Code 用不了：${known?.unavailableReason ?? "没装或启动不了"}`);
    }
    const found = await findClaudeSession(this.deps.claudeProjectsDir ?? defaultClaudeProjectsDir(), id);
    return found ?? error(404, "这台 Mac 上没有这个 Claude Code 会话（只能接管 ~/.claude/projects 里终端开的会话）");
  }

  private takeoverFields(session: LinkSession): Record<string, unknown> {
    return { name: session.harnessName, cwd: session.cwd, title: session.title, seq: session.seq, external_session_id: session.externalSessionId };
  }

  /** 把终端里的最近一段对话写进事件日志:手机按 seq 收到历史,和这里开的会话一样回放。 */
  private async replayExternal(session: LinkSession, takeover: ExternalSession): Promise<void> {
    const history = await readClaudeHistory(takeover.file).catch((cause: unknown) => {
      this.deps.logger.warn("[leo/link] reading Claude history failed", { error: String(cause) });
      return { events: [], truncated: false };
    });
    session.emit({
      event: "session.note",
      text: history.truncated
        ? "接上了 Mac 终端里的 Claude Code 会话。更早的对话留在 Mac 上，这里是最近的一段；接着发消息就在原会话上继续。"
        : "接上了 Mac 终端里的 Claude Code 会话，下面是之前的对话；接着发消息就在原会话上继续。",
    });
    for (const event of history.events) session.emit(event);
    if (takeover.running) {
      session.emit({ event: "session.note", text: "Mac 终端里这个会话还开着，两边同时发消息会打架：最好先在终端里退出 claude。" });
    }
    // 回放完才装:回放里的正文 / 工具事件不算 agent 的产出。
    this.armResumeCheck(session);
  }

  private armResumeCheck(session: LinkSession): void {
    const externalId = session.externalSessionId;
    if (!externalId) return;
    const statePath = this.deps.acpSessionsPath ?? defaultAcpSessionsPath();
    session.resumeCheck = () => acpResumeHeld(statePath, session.sessionId, externalId);
  }

  private async send(
    session: LinkSession,
    body: Record<string, unknown>,
    caller: Caller,
    req?: LinkRequest,
  ): Promise<LinkResponse> {
    const text = String(body["text"] ?? "");
    if (!text) return error(400, "text is required");
    if (typeof body["full_auto"] === "boolean") {
      const wanted = body["full_auto"];
      if (wanted && !mayUseFullAuto(caller))
        return deviceNotRecognized("认不出是哪台设备发来的，不能开全自动；按步骤在 Mac 上处理后再试");
      // "关"只把全自动任务切回先问我;计划、编辑这类别的模式不动(手机每条消息都会带开关状态)。
      const target = wanted ? "yolo" : session.isFullAuto ? "build" : null;
      if (target) {
        try {
          await session.setMode(target);
        } catch (cause) {
          return error(
            502,
            `切换模式失败：${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }
    // 处在全自动(完全访问)的任务 —— 手机开的、Mac 桌面上自己设的、重启后认回来的 —— 不接受认不出身份的消息:
    // 否则谁拿到中继 0.1 的通道发一句话,就能让 Mac 免审批地跑命令。
    if (session.isFullAuto && !mayUseFullAuto(caller)) {
      return deviceNotRecognized(
        "这个任务在 Mac 上是全自动（完全访问）模式，认不出是哪台设备发来的消息不接；在 Mac 上把它切回「先问我」，或按步骤在 Mac 上处理",
      );
    }
    const phoneSessionId = phoneSessionIdOf(body);
    if (phoneSessionId) session.phoneSessionId = phoneSessionId;
    try {
      if (req?.requestId)
        await this.receipts.checkpoint(req, {
          stage: "sending",
          cwd: session.cwd,
          taskId: session.sessionId,
        });
      await session.send(
        text,
        caller,
        req?.requestId ? this.receipts.operationId(req, "send") : undefined,
      );
    } catch (cause) {
      if (req?.requestId) throw cause;
      return error(409, cause instanceof Error ? cause.message : String(cause));
    }
    void this.saveIndex().catch(() => undefined);
    return { status: 200, body: { ok: true, seq: session.seq } };
  }

  private async approve(
    session: LinkSession,
    body: Record<string, unknown>,
    caller: Caller,
  ): Promise<LinkResponse> {
    // 旧客户端可能回 "always":按「本任务都允许」处理,绝不当成永久放行。
    const rawChoice = String(body["choice"] ?? "").toLowerCase();
    const choice = rawChoice === "always" ? "session" : rawChoice;
    let approvalId = body["approval_id"] == null ? null : String(body["approval_id"]);
    if (!approvalId && session.pendingApprovals.size === 1)
      approvalId = [...session.pendingApprovals.keys()][0]!;
    if (!approvalId || !session.pendingApprovals.has(approvalId))
      return error(409, "No such pending approval");
    if (!APPROVAL_CHOICES.includes(choice as ApprovalChoice)) {
      return error(400, `Invalid choice; expected one of: ${APPROVAL_CHOICES.join(", ")}`);
    }
    const result = await session.respond(approvalId, choice as ApprovalChoice, caller);
    if (result === "missing") return error(409, "No such pending approval");
    if (result === "forbidden")
      return error(403, "认不出是哪台设备，只能拒绝；请在 Mac 上批准，或把中继升级到 0.2");
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
      if (this.desktopTasks.has(sessionId))
        return { status: 200, body: { ok: true, archived: false } };
      if (!this.legacyEnabled()) return { status: 200, body: { ok: true, archived: false } };
      return this.leoagent.request("POST", pathname, body);
    }
    if (session.status === "running" || session.status === "waiting_for_approval") {
      return error(409, "任务还在跑：先停止，再清理");
    }
    this.sessions.delete(sessionId);
    await session.close();
    await this.saveIndex();
    return { status: 200, body: { ok: true, archived: true } };
  }

  /** 手机关掉全自动:它发起、还在跑的全自动任务切回「先问我」。 */
  private async fullAutoOff(req: LinkRequest): Promise<LinkResponse> {
    if (record(req.body)["enabled"] !== false) return error(400, '只支持关闭：{"enabled": false}');
    const switched: string[] = [];
    for (const session of this.sessions.values()) {
      if (!session.isFullAuto) continue;
      const owner = session.lastCaller;
      if (req.caller.deviceId && owner?.deviceId && owner.deviceId !== req.caller.deviceId)
        continue;
      try {
        await session.setMode("build");
        switched.push(session.sessionId);
      } catch (cause) {
        // 切不动就停掉,宁可停也不能继续免审批地跑。
        this.deps.logger.warn("[leo/link] setMode build failed; stopping", {
          error: String(cause),
        });
        await session.stop().catch(() => undefined);
        switched.push(session.sessionId);
      }
    }
    if (switched.length > 0) void this.saveIndex().catch(() => undefined);
    // 本机 leoagent 里的 claude / codex / grok 全自动任务一并切回;老版本没有这条路(404),忽略。
    if (!this.legacyEnabled()) return { status: 200, body: { ok: true, sessions: switched } };
    const upstream = await this.leoagent.request("POST", "/harness/full-auto", { enabled: false }, req.caller);
    const theirs = upstream.status === 200 ? record(upstream.body)["sessions"] : undefined;
    if (Array.isArray(theirs)) switched.push(...theirs.filter((id): id is string => typeof id === "string"));
    // leoagent 超时 / 出错时不能回 ok:手机会以为都关了,而那边的任务还在免审批地跑。
    // 回错误让手机按它的节奏重试(重复关是幂等的);503(没配 leoagent)和 404(老版本)没有可关的。
    if (![200, 404, 503].includes(upstream.status))
      return error(502, "Mac 上的任务已切回「先问我」，但本机 leoagent 没确认切回，请重试");
    return { status: 200, body: { ok: true, sessions: switched } };
  }
}
