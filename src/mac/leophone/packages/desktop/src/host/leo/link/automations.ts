import { promises as fsp } from "node:fs";

import type { IZCodeAgentService } from "@zcode/services";
import {
  isAutomationCreateLimitError,
  type ModelSelection,
  type ZCodeAutomation,
} from "@zcode/shared";
import { LEO_AUTOMATION_TEMPLATES } from "@zcode/shared/leo-automation-templates";

import type { AutomationRunCompleted } from "./automationEvents.js";
import {
  automationView,
  describeSchedule,
  latestRun,
  parseCreate,
  parsePatch,
  patchNeedsFullAuto,
} from "./automationPayload.js";
import { AutomationResults, runSummary } from "./automationResults.js";
import type { LinkRequest, LinkResponse } from "./bridge.js";
import type { HarnessEvent } from "./journal.js";
import { deviceNotRecognized, error, mayUseFullAuto } from "./linkPolicy.js";

/**
 * [up-p3-mac] 手机管理 Mac 上的定时任务(docs/specs/leo-link-automations.md)。
 * 自动化服务是唯一所有者:这里只校验、换算、转调 IZCodeAgentService,不碰它的存储、不留副本。
 */
export type LinkAutomationService = Pick<
  IZCodeAgentService,
  | "listAllAutomations"
  | "listAutomationRuns"
  | "createAutomation"
  | "updateAutomation"
  | "setAutomationEnabled"
  | "deleteAutomation"
  | "runAutomationNow"
>;

const AUTOMATION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
/** 服务层的校验错误:原样给手机看(400),其它异常算 Mac 上处理失败(502)。 */
const VALIDATION_ERRORS = new Set([
  "InvalidCronExprError",
  "InvalidAutomationMaxRunsUpdateError",
  "InvalidAutomationScheduleRuleError",
  "InvalidAutomationRelativeDelayError",
  "InvalidAutomationIntervalCarrierError",
  "StaleOneShotAutomationScheduleError",
]);

function serviceError(cause: unknown): LinkResponse {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (isAutomationCreateLimitError(cause))
    return {
      status: 409,
      body: {
        error: {
          code: "automation_limit",
          message: "这台 Mac 上的定时任务已到上限（20 个），先删掉一些",
        },
      },
    };
  if (cause instanceof Error && VALIDATION_ERRORS.has(cause.name)) return error(400, message);
  return error(502, `Mac 上处理失败：${message}`);
}

type Logger = { warn: (msg: string, meta?: unknown) => void };

export type LinkAutomationsDeps = {
  service: LinkAutomationService;
  /** 和手机开任务同一规则:空或 "~" → 手机最近用过的项目,没有就主目录。 */
  resolveCwd: (requested: string) => string;
  /** 和手机开任务同一个模型 / ACP agent;认不出或没配模型时给出错误响应。 */
  resolveModel: (harness: string) => Promise<{ modelSelection?: ModelSelection } | LinkResponse>;
  checkpoint: (req: LinkRequest, value: Record<string, unknown>) => Promise<void>;
  logger: Logger;
  now?: () => Date;
  /** [up-c-mac] 这次运行的最终助手回复(原文);读不到给 null。没有就只给固定文案。 */
  finalReply?: (run: AutomationRunCompleted) => Promise<string | null>;
  /** [up-c-mac] 运行摘要落盘的文件;没有就只记在内存里。 */
  resultsFile?: string;
};

const FULL_AUTO_REFUSED =
  "认不出是哪台设备发来的，不能让定时任务全自动地跑；按步骤在 Mac 上处理后再试";

/** [up-c-mac] 手机可直接拿来建的模板(和 Mac 自动化页「从模板开始」同一份,中文)。 */
function templatesView() {
  return LEO_AUTOMATION_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.title.cn,
    description: template.description.cn,
    prompt: template.prompt.cn,
    // 和自动化视图的 schedule 同形;整份原样放回 POST /automations 的 schedule 也认(按其中的 cron)。
    schedule: describeSchedule({ cronExpr: template.cronExpr, recurring: true }),
    mode: template.mode,
  }));
}

export class LinkAutomations {
  private readonly results: AutomationResults;

  constructor(private readonly deps: LinkAutomationsDeps) {
    this.results = new AutomationResults(deps.resultsFile ?? null);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async handle(method: string, pathname: string, req: LinkRequest): Promise<LinkResponse> {
    if (pathname === "/automations") {
      if (method === "GET") return this.list();
      if (method === "POST") return this.create(req);
      return error(405, "Method not allowed");
    }
    if (pathname === "/automations/templates")
      return method === "GET"
        ? { status: 200, body: { templates: templatesView() } }
        : error(405, "Method not allowed");
    const match = /^\/automations\/([^/]+)(\/run)?$/.exec(pathname);
    // 畸形的 % 转义(如 %E0%A4%A)让 decodeURIComponent 抛 URIError,以前冒成 500;它就是不合法的 id。
    let id = "";
    try {
      id = decodeURIComponent(match?.[1] ?? "");
    } catch {
      return error(400, "定时任务 id 不合法");
    }
    if (!match || !AUTOMATION_ID.test(id)) return error(400, "定时任务 id 不合法");
    if (match[2]) return method === "POST" ? this.run(id, req) : error(405, "Method not allowed");
    if (method === "PATCH") return this.patch(id, req);
    if (method === "DELETE") return this.remove(id);
    if (method === "GET") {
      const found = await this.find(id);
      return found ? { status: 200, body: { automation: await this.view(found) } } : this.missing();
    }
    return error(405, "Method not allowed");
  }

  /** Mac 在「已建好、回执未落」之间崩溃:按检查点回那条自动化,不再建一条。 */
  async recover(checkpoint: Record<string, unknown>): Promise<LinkResponse | null> {
    if (
      checkpoint["stage"] !== "automation_created" ||
      typeof checkpoint["automationId"] !== "string"
    )
      return null;
    const found = await this.find(checkpoint["automationId"]);
    return found ? { status: 201, body: { automation: await this.view(found) } } : null;
  }

  /** 名字、模式以自动化服务为准;查不到(已删)用占位。 */
  async describe(automationId: string): Promise<{ name: string; mode?: string }> {
    const automation = await this.find(automationId).catch(() => null);
    return { name: automation?.title ?? "定时任务", ...(automation?.mode ? { mode: automation.mode } : {}) };
  }

  /**
   * 运行结束 → 推给手机的事件。summary:成功 = 最终回复的纯文本摘要(≤280 字),
   * 失败 = 错误原因(≤280 字),停止 = 固定文案;同时记下,之后 GET 的 last_run.summary 就是它。
   */
  async completedEvent(
    run: AutomationRunCompleted,
  ): Promise<{ event: HarnessEvent; name: string; mode?: string }> {
    const automation = await this.find(run.automationId).catch(() => null);
    const name = automation?.title ?? "定时任务";
    const reply =
      run.outcome === "succeeded" && this.deps.finalReply
        ? await this.deps.finalReply(run).catch((cause: unknown) => {
            this.deps.logger.warn("[leo/link] reading automation reply failed", { error: String(cause) });
            return null;
          })
        : null;
    const summary = runSummary(run.outcome, run.error, reply);
    await this.results.set(run.runId, summary).catch((cause: unknown) => {
      this.deps.logger.warn("[leo/link] saving automation result failed", { error: String(cause) });
    });
    return {
      name,
      ...(automation?.mode ? { mode: automation.mode } : {}),
      event: {
        event: "automation.run.completed",
        automation_id: run.automationId,
        name,
        status: run.outcome,
        summary,
        task_id: run.taskId,
        session_id: run.taskId,
        run_id: run.runId,
        trigger: run.trigger,
        workspace: run.workspacePath,
        timestamp: this.now().getTime() / 1000,
      },
    };
  }

  private missing(): LinkResponse {
    return error(404, "这台 Mac 上没有这个定时任务");
  }

  private async find(id: string): Promise<ZCodeAutomation | null> {
    return (
      (await this.deps.service.listAllAutomations()).find((item) => item.automationId === id) ??
      null
    );
  }

  private async view(automation: ZCodeAutomation) {
    const runs = await this.deps.service
      .listAutomationRuns({
        automationId: automation.automationId,
        workspacePath: automation.workspacePath,
        ...(automation.workspaceIdentity
          ? { workspaceIdentity: automation.workspaceIdentity }
          : {}),
      })
      .catch((cause: unknown) => {
        this.deps.logger.warn("[leo/link] listing automation runs failed", {
          error: String(cause),
        });
        return [];
      });
    const last = latestRun(runs);
    const recorded = last ? await this.results.get(last.runId).catch(() => undefined) : undefined;
    return automationView(automation, runs, recorded);
  }

  private scope(automation: ZCodeAutomation) {
    return {
      automationId: automation.automationId,
      workspacePath: automation.workspacePath,
      ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
    };
  }

  private async list(): Promise<LinkResponse> {
    try {
      const all = await this.deps.service.listAllAutomations();
      const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
      return {
        status: 200,
        body: { automations: await Promise.all(sorted.map((item) => this.view(item))) },
      };
    } catch (cause) {
      return serviceError(cause);
    }
  }

  private async create(req: LinkRequest): Promise<LinkResponse> {
    // 没有操作编号就没法认出重试:手机网络一抖就会建出两条一样的定时任务。
    if (!req.requestId) return error(400, "建定时任务必须带操作编号（request_id / X-Request-Id）");
    const input = parseCreate(req.body, this.now());
    if ("error" in input) return error(400, input.error);
    if (input.mode === "yolo" && !mayUseFullAuto(req.caller))
      return deviceNotRecognized(FULL_AUTO_REFUSED);
    const workspacePath = this.deps.resolveCwd(input.workspace);
    const stat = await fsp.stat(workspacePath).catch(() => null);
    if (!stat?.isDirectory()) return error(400, `这台 Mac 上没有这个目录：${workspacePath}`);
    const model = await this.deps.resolveModel(input.harness);
    if ("status" in model) return model;
    let created: ZCodeAutomation;
    try {
      created = await this.deps.service.createAutomation({
        workspacePath,
        title: input.name,
        prompt: input.prompt,
        cronExpr: input.schedule.cronExpr,
        recurring: input.schedule.recurring,
        mode: input.mode,
        ...(model.modelSelection ? { modelSelection: model.modelSelection } : {}),
      });
    } catch (cause) {
      return serviceError(cause);
    }
    await this.deps.checkpoint(req, {
      stage: "automation_created",
      automationId: created.automationId,
    });
    return { status: 201, body: { automation: await this.view(created) } };
  }

  private async patch(id: string, req: LinkRequest): Promise<LinkResponse> {
    const patch = parsePatch(req.body, this.now());
    if ("error" in patch) return error(400, patch.error);
    const existing = await this.find(id);
    if (!existing) return this.missing();
    if (patchNeedsFullAuto(existing.mode, patch) && !mayUseFullAuto(req.caller))
      return deviceNotRecognized(FULL_AUTO_REFUSED);
    try {
      if (patch.name !== undefined || patch.prompt !== undefined || patch.schedule || patch.mode) {
        const updated = await this.deps.service.updateAutomation({
          ...this.scope(existing),
          ...(patch.name !== undefined ? { title: patch.name } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.mode ? { mode: patch.mode } : {}),
          // 手机改计划 = 普通 cron:清掉桌面的自定义规则,并标记为用户改过(和设置页一致)。
          ...(patch.schedule
            ? {
                cronExpr: patch.schedule.cronExpr,
                recurring: true,
                scheduleRule: null,
                scheduleEditedByUser: true,
              }
            : {}),
        });
        if (!updated) return this.missing();
      }
      if (patch.enabled !== undefined) {
        await this.deps.service.setAutomationEnabled({
          ...this.scope(existing),
          enabled: patch.enabled,
        });
      }
    } catch (cause) {
      return serviceError(cause);
    }
    const current = await this.find(id);
    return current
      ? { status: 200, body: { automation: await this.view(current) } }
      : this.missing();
  }

  private async remove(id: string): Promise<LinkResponse> {
    const existing = await this.find(id);
    if (!existing) return this.missing();
    try {
      await this.deps.service.deleteAutomation(this.scope(existing));
    } catch (cause) {
      return serviceError(cause);
    }
    return { status: 200, body: { ok: true, deleted: true } };
  }

  private async run(id: string, req: LinkRequest): Promise<LinkResponse> {
    const existing = await this.find(id);
    if (!existing) return this.missing();
    if (existing.mode === "yolo" && !mayUseFullAuto(req.caller))
      return deviceNotRecognized(FULL_AUTO_REFUSED);
    try {
      const result = await this.deps.service.runAutomationNow(this.scope(existing));
      if (result.status === "duplicate")
        return {
          status: 409,
          body: {
            error: {
              code: "automation_run_in_flight",
              message: "这个定时任务正在跑，等它跑完再试",
            },
          },
        };
      return { status: 202, body: { ok: true, status: "queued" } };
    } catch (cause) {
      return serviceError(cause);
    }
  }
}
