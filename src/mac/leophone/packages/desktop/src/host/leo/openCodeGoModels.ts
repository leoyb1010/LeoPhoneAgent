import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type PiModel = ReturnType<ModelRuntime["getModels"]>[number];

/**
 * [leo] OpenCode Go 的模型以官方实时列表为准。
 *
 * pi 自带的 opencode-go 模型表是它发版时生成的,跟不上 OpenCode 上新(0.85.1 只有 27 个,线上已经 40 多个),
 * 登录后「订阅账号」里就少一截。模型列表 https://opencode.ai/zen/go/v1/models 是公开接口,不带 Key 也能读;
 * 读不到(离线、被墙)就退回 pi 自带的表。每个模型走哪种接口:pi 表里有的照 pi(和 OpenCode 自家客户端一致),
 * 没有的跟同系列的走,同系列一个都没有才按官方文档的端点表(见 documentedApi)。
 */
export const OPENCODE_GO = "opencode-go";
const MODELS_URL = "https://opencode.ai/zen/go/v1/models";
/** 官方列表里还挂着、一调用就回 "Model is unavailable" 的下线模型(2026-09-27 实测),不给用户选。 */
const RETIRED = new Set([
  "kimi-k2.5",
  "glm-5",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "hy3-preview",
  "grok-4.5",
]);
const LIST_TTL_MS = 6 * 60 * 60_000;

let live: { at: number; ids: string[] } | null = null;
let fetching: Promise<void> | null = null;
let fetchList: typeof fetch = (input, init) => fetch(input, init);

async function refresh(): Promise<void> {
  try {
    const res = await fetchList(MODELS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string" && /^[\w.-]+$/.test(id));
    if (ids.length > 0) live = { at: Date.now(), ids };
  } catch {
    // 离线就沿用上一次的列表,或者 pi 自带的表。
  }
}

/** 官方列表里的模型 id;一次都没读到过就是 null。 */
export async function openCodeGoModelIds(): Promise<string[] | null> {
  if (!live || Date.now() - live.at > LIST_TTL_MS) {
    fetching ??= refresh().finally(() => {
      fetching = null;
    });
    await fetching;
  }
  return live?.ids ?? null;
}

/** 测试用:直接给定官方列表(null 表示没读到),可顺带换掉联网读取。 */
export function setOpenCodeGoIdsForTest(ids: string[] | null, fetcher?: typeof fetch): void {
  live = ids ? { at: Date.now(), ids } : null;
  if (fetcher) fetchList = fetcher;
}

/** 系列前缀:glm-5.3-flash → glm-,kimi-k2.7-code → kimi-k,qwen3.8-max → qwen,hy4-preview → hy。 */
function family(id: string): string {
  return id.toLowerCase().replace(/[\d.].*$/, "");
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** 官方文档(opencode.ai/v2/docs/console/go)的端点表:GPT / Grok / Muse 走 Responses,MiniMax、Qwen 走 Anthropic Messages,其余走 Chat Completions。 */
export function documentedApi(
  id: string,
): "openai-responses" | "anthropic-messages" | "openai-completions" {
  const lower = id.toLowerCase();
  if (/^(gpt-|grok-|muse-spark-)/.test(lower)) return "openai-responses";
  if (/^(minimax-|qwen)/.test(lower)) return "anthropic-messages";
  return "openai-completions";
}

/** pi 表里没有的模型:照同系列里名字最像的一个配(接口、地址、兼容参数跟着它);同系列没有就按文档端点表配一个最朴素的。 */
export function synthesizeOpenCodeGoModel(
  id: string,
  builtins: readonly PiModel[],
): PiModel | null {
  const kin = [...builtins]
    .filter((model) => family(model.id) === family(id))
    .sort((a, b) => sharedPrefix(b.id, id) - sharedPrefix(a.id, id));
  const template = kin[0];
  if (template) return { ...template, id, name: id };
  const api = documentedApi(id);
  const base = builtins.find((model) => model.api === api);
  if (!base) return null;
  const plain: PiModel = { ...base, id, name: id, reasoning: false, input: ["text"] };
  delete (plain as { compat?: unknown }).compat;
  delete (plain as { thinkingLevelMap?: unknown }).thinkingLevelMap;
  return plain;
}

/**
 * 文档把 MiniMax、Qwen 全放在 /v1/messages;pi 的表有几个标成了 Chat Completions,
 * 其中 minimax-m2.7 走 chat 会被拒("Model does not support this protocol",2026-09-27 实测)。
 * 这类模型改走 Anthropic Messages,地址用表里 Anthropic 模型的根(不带 /v1)。
 */
function withDocumentedApi(model: PiModel, builtins: readonly PiModel[]): PiModel {
  if (documentedApi(model.id) !== "anthropic-messages" || model.api === "anthropic-messages") {
    return model;
  }
  const baseUrl =
    builtins.find((candidate) => candidate.api === "anthropic-messages")?.baseUrl ??
    "https://opencode.ai/zen/go";
  const moved = { ...model, api: "anthropic-messages", baseUrl } as PiModel;
  delete (moved as { compat?: unknown }).compat;
  delete (moved as { thinkingLevelMap?: unknown }).thinkingLevelMap;
  return moved;
}

/** 这家订阅能用的模型:OpenCode Go 以官方实时列表为准(去掉已下线的),其余就是 pi 自带的表。 */
export async function providerModels(
  runtime: ModelRuntime,
  providerId: string,
): Promise<readonly PiModel[]> {
  const builtins = runtime.getModels(providerId);
  if (providerId !== OPENCODE_GO) return builtins;
  const ids = await openCodeGoModelIds();
  const byId = new Map(builtins.map((model) => [model.id, model]));
  const models: PiModel[] = [];
  for (const id of ids ?? builtins.map((model) => model.id)) {
    if (RETIRED.has(id)) continue;
    const model = byId.get(id) ?? synthesizeOpenCodeGoModel(id, builtins);
    if (model) models.push(withDocumentedApi(model, builtins));
  }
  return models;
}

/**
 * OpenCode(Go / Zen)对不带会话 id 的模型请求一律回 400 MissingSessionID(2026-09-27 实测),
 * 文档要求每个对话带一个固定的 x-opencode-session。代理替调用方补上:沿用调用方带来的会话 id
 * (ZCode 内核每个会话都发 x-session-id),没有就临时生成一个。别家模型返回 undefined,请求不变。
 */
export function openCodeSessionHeaders(
  model: Pick<PiModel, "provider" | "baseUrl">,
  incoming: IncomingHttpHeaders,
): Record<string, string> | undefined {
  let host = "";
  try {
    host = new URL(model.baseUrl).hostname;
  } catch {
    // baseUrl 不是合法地址就只按 provider 判断。
  }
  if (model.provider !== OPENCODE_GO && model.provider !== "opencode" && host !== "opencode.ai") {
    return undefined;
  }
  const given = [incoming["x-opencode-session"], incoming["x-session-id"]]
    .map((value) => (Array.isArray(value) ? value[0] : value)?.trim())
    .find((value) => value && /^[\w.:-]{1,200}$/.test(value));
  return { "x-opencode-session": given ?? randomUUID() };
}
