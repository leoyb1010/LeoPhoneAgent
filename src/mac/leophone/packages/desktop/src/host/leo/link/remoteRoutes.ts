// [remote-ctl-mac] 手机远控的会话操作(docs/specs/leo-link-remote-controls.md):
// GET /harness/models 与 POST /harness/sessions/:id/(model|compact|rename|answer|follow)。
// 都只转调内核(IZCodeTaskService)与会话自己的状态,不另存一份任务状态。
import type { IZCodeTaskService, ModelSelectionView } from "@zcode/services";
import { generateTraceId, type ModelSelection } from "@zcode/shared";

import type { LinkResponse } from "./bridge.js";
import { error } from "./linkPolicy.js";
import { createModelChoice, findModel, modelCatalog, sessionModel, type CatalogModel, type CreateModelChoice } from "./remoteModels.js";
import { parseAnswer } from "./remoteQuestions.js";
import type { LinkSession } from "./session.js";

type Logger = { warn: (msg: string, meta?: unknown) => void };

export type RemoteControlDeps = {
  taskService: IZCodeTaskService;
  logger: Logger;
  /** 桌面模型选择器的视图;没有就不支持模型相关接口。 */
  modelView?: () => Promise<ModelSelectionView>;
  /** LeoBot 的自动选择(与新建任务同一规则);null = 一个都没配。 */
  defaultModel: () => Promise<ModelSelection | null | undefined>;
  saveIndex: () => void;
};

/** 内核的思考档位配置项 id(zcodeConfigOptions.THOUGHT_LEVEL_CONFIG_ID;services 没从公开入口导出)。 */
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const TITLE_MAX = 200;
export const REMOTE_SESSION_ACTIONS = ["model", "compact", "rename", "answer", "follow"] as const;
export type RemoteSessionAction = (typeof REMOTE_SESSION_ACTIONS)[number];

async function catalog(deps: RemoteControlDeps): Promise<CatalogModel[] | null> {
  if (!deps.modelView) return null;
  return modelCatalog(await deps.modelView());
}

export async function listModels(deps: RemoteControlDeps): Promise<LinkResponse> {
  if (!deps.modelView) return error(404, "这台 Mac 不支持远程选择模型");
  try {
    const models = (await catalog(deps)) ?? [];
    const fallback = await deps.defaultModel().catch(() => undefined);
    return {
      status: 200,
      body: {
        models,
        default: fallback
          ? { provider: fallback.providerId, model: fallback.modelId, effort: fallback.options?.reasoningLevel ?? null }
          : null,
      },
    };
  } catch (cause) {
    deps.logger.warn("[leo/link] listing models failed", { error: String(cause) });
    return error(502, `Mac 上读取模型失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** 新建任务带的 model / effort / thinking;都没带不读模型清单(旧手机零开销)。 */
export async function chooseCreateModel(
  deps: RemoteControlDeps,
  body: Record<string, unknown>,
  fallback: ModelSelection | null | undefined,
): Promise<CreateModelChoice> {
  if (body["model"] == null && body["effort"] == null && body["thinking"] == null) return null;
  const models = await catalog(deps).catch(() => null);
  return models ? createModelChoice(body, models, fallback) : null;
}

export async function sessionControl(
  action: RemoteSessionAction,
  session: LinkSession,
  body: Record<string, unknown>,
  deps: RemoteControlDeps,
): Promise<LinkResponse> {
  switch (action) {
    case "model":
      return setModel(session, body, deps);
    case "compact":
      return compact(session, deps);
    case "rename":
      return rename(session, body, deps);
    case "answer":
      return answer(session, body);
    default: {
      if (typeof body["following"] !== "boolean") return error(400, "following 必须是 true / false");
      session.setFollowing(body["following"]);
      return { status: 200, body: { following: session.following } };
    }
  }
}

async function setModel(session: LinkSession, body: Record<string, unknown>, deps: RemoteControlDeps): Promise<LinkResponse> {
  if (session.harness !== "zcode") return error(400, `「${session.harnessName}」的会话不能在手机上换模型`);
  const models = await catalog(deps).catch(() => null);
  if (!models) return error(404, "这台 Mac 不支持远程换模型");
  const provider = body["provider"];
  const model = body["model"];
  const effort = typeof body["effort"] === "string" ? body["effort"].trim() : undefined;
  if (body["effort"] != null && !effort) return error(400, "effort 必须是非空字符串");
  const switching = provider != null || model != null;
  if (switching && (typeof provider !== "string" || typeof model !== "string"))
    return error(400, "provider 与 model 必须同时给出");
  if (!switching && !effort) return error(400, "至少给出 provider + model，或 effort");
  let target: CatalogModel | undefined;
  if (switching) {
    target = findModel(models, provider as string, model as string);
    if (!target) return error(400, `这台 Mac 上没有模型「${String(provider)}/${String(model)}」`);
  } else {
    const current = session.model ?? (await readModel(session, deps));
    if (!current) return error(409, "这个任务还没选模型：先选模型，再设推理强度");
    target = findModel(models, current.provider, current.model);
    if (!target) return error(400, `当前模型「${current.provider}/${current.model}」不在可选列表里`);
  }
  if (effort && !target.efforts.includes(effort))
    return error(400, `模型「${target.name}」不支持推理强度「${effort}」`);
  const { taskService } = deps;
  const traceId = generateTraceId(session.sessionId);
  try {
    await session.ensureResumed();
    if (switching) {
      await taskService.setModel({
        taskId: session.sessionId,
        traceId,
        modelSelection: { providerId: target.provider, modelId: target.model, ...(effort ? { options: { reasoningLevel: effort } } : {}) },
      });
    }
    // 跨模型切换时内核先用目标模型的默认档位;显式给了强度再单独收敛一次(同值时内核 noop)。
    if (effort) await taskService.setConfigOption({ taskId: session.sessionId, traceId, configId: THOUGHT_LEVEL_CONFIG_ID, value: effort });
  } catch (cause) {
    deps.logger.warn("[leo/link] switching model failed", { error: String(cause) });
    return error(502, `Mac 上换模型失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  // 以内核读回的为准(没给强度时它按目标模型的默认档位);读不到就按请求记。
  const actual = await readModel(session, deps);
  session.updateModel(
    actual ?? { provider: target.provider, model: target.model, name: target.name, effort: effort ?? (switching ? null : session.model?.effort ?? null) },
  );
  return { status: 200, body: { model: session.model } };
}

async function readModel(session: LinkSession, deps: RemoteControlDeps) {
  const selection = await deps.taskService.getTaskModelSelection({ taskId: session.sessionId }).catch(() => null);
  return selection ? sessionModel(selection) : null;
}

async function compact(session: LinkSession, deps: RemoteControlDeps): Promise<LinkResponse> {
  if (session.status === "running" || session.status === "waiting_for_approval")
    return error(409, "任务还在跑：等这一轮结束再压缩");
  try {
    await session.ensureResumed();
  } catch (cause) {
    return error(502, `Mac 上恢复任务失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  // 压缩要让模型总结整段对话,可能很久:先回 202,结果以会话提示告诉手机。
  void deps.taskService.compactSession({ taskId: session.sessionId, workspacePath: session.cwd }).then(
    () => session.emit({ event: "session.note", kind: "compacted", text: "已压缩这个任务的上下文" }),
    (cause: unknown) => {
      deps.logger.warn("[leo/link] compact failed", { error: String(cause) });
      session.emit({ event: "session.note", kind: "compact_failed", text: `压缩上下文失败：${cause instanceof Error ? cause.message : String(cause)}` });
    },
  );
  return { status: 202, body: { ok: true } };
}

async function rename(session: LinkSession, body: Record<string, unknown>, deps: RemoteControlDeps): Promise<LinkResponse> {
  const title = typeof body["title"] === "string" ? body["title"].replace(/\s+/g, " ").trim() : "";
  if (!title) return error(400, "title 不能为空");
  if (title.length > TITLE_MAX) return error(400, `title 不能超过 ${TITLE_MAX} 字`);
  try {
    const meta = await deps.taskService.renameTask({ taskId: session.sessionId, workspacePath: session.cwd, title });
    session.title = meta?.title || title;
  } catch (cause) {
    deps.logger.warn("[leo/link] rename failed", { error: String(cause) });
    return error(502, `Mac 上改名失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  deps.saveIndex();
  return { status: 200, body: { title: session.title } };
}

async function answer(session: LinkSession, body: Record<string, unknown>): Promise<LinkResponse> {
  const questionId = body["question_id"];
  if (typeof questionId !== "string" || !questionId) return error(400, "question_id is required");
  const questions = session.pendingQuestions.get(questionId);
  if (!questions) return error(409, "没有这个待回答的问题（可能已在 Mac 上答过或这一轮已结束）");
  const parsed = parseAnswer(body, questions);
  if ("error" in parsed) return error(400, parsed.error);
  try {
    const result = await session.answerQuestion(questionId, "decline" in parsed ? null : parsed.content);
    if (result === "missing") return error(409, "没有这个待回答的问题（可能已在 Mac 上答过或这一轮已结束）");
  } catch (cause) {
    return error(502, `回答没送到 Mac 上的任务：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { status: 200, body: { ok: true, question_id: questionId } };
}
