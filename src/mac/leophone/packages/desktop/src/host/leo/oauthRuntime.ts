import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { leoPath } from "./leoPaths.js";
import { OPENCODE_GO, providerModels } from "./openCodeGoModels.js";

/**
 * [leo] 订阅账号登录:ChatGPT(Codex)、GitHub Copilot 等走 OAuth,OpenCode Go 走 API Key。
 *
 * 用 pi 的 ModelRuntime —— 它负责每家的授权流程(浏览器回跳 / 设备码 / 填 Key)、token
 * 存储与过期刷新,以及每家接口的细节(Codex 的专用端点、Copilot 的 token 交换、
 * OpenCode Go 按模型分三种协议)。凭据只落在本机 `~/.leoagent/oauth/auth.json`,不出机器。
 */
const OAUTH_DIR = leoPath("oauth");
const AUTH_PATH = leoPath("oauth", "auth.json");
const MODELS_PATH = leoPath("oauth", "models.json");

let runtimePromise: Promise<ModelRuntime> | null = null;

/**
 * 懒加载 pi:只有用到订阅账号时才加载。加载失败只影响订阅登录这一块,不会拖垮 Host
 * (Host 起不来整个应用就起不来)。
 */
async function loadModelRuntimeClass(): Promise<typeof ModelRuntime> {
  // pi 会从自己的 package.json 读版本与配置名;内联进 host 后按文件位置找不到它,这里指回包目录。
  const packagedPiDir = process.resourcesPath
    ? join(process.resourcesPath, "app.asar", "node_modules", "@earendil-works", "pi-coding-agent")
    : "";
  if (
    !process.env["PI_PACKAGE_DIR"] &&
    packagedPiDir &&
    existsSync(join(packagedPiDir, "package.json"))
  ) {
    process.env["PI_PACKAGE_DIR"] = packagedPiDir;
  }
  const mod = await import("@earendil-works/pi-coding-agent");
  return mod.ModelRuntime;
}

export function oauthRuntime(): Promise<ModelRuntime> {
  if (!runtimePromise) {
    mkdirSync(OAUTH_DIR, { recursive: true, mode: 0o700 });
    const created = loadModelRuntimeClass().then((Runtime) =>
      Runtime.create({
        authPath: AUTH_PATH,
        modelsPath: MODELS_PATH,
        modelsStorePath: leoPath("oauth", "models-store.json"),
        allowModelNetwork: false,
        // 必须为 true:isUsingOAuth / hasConfiguredAuth 读的是 refresh 建好的快照;allowModelNetwork=false
        // 时这一步只读本机凭据与内置模型表,不联网。设成 false 会导致登录后永远识别不到已登录的账号。
        refreshOnCreate: true,
      }),
    );
    // 失败了下次再试,不把一次失败永久缓存下来。
    created.catch(() => {
      if (runtimePromise === created) runtimePromise = null;
    });
    runtimePromise = created;
  }
  return runtimePromise;
}

/** 请求本身有问题(不支持的登录方式、缺 Key):本机接口按 400 回,不当成服务出错。 */
export class OAuthRequestError extends Error {}

/** 凭据文件变了(登录 / 退出)就重建,它自己不监听文件。 */
export function resetOAuthRuntime(): void {
  runtimePromise = null;
}

/**
 * 不上架的登录方式:
 * - anthropic:Claude 订阅登录只许用在官方 Claude Code 里,第三方应用代发请求违反 Anthropic 条款。
 *   要用 Claude,走 API Key 供应商,或在手机上远程开 Mac 上你自己登录的官方 claude CLI。
 * - radius:pi 作者方的第三方网关,与「请求直连各家官方接口」的承诺不符。
 */
function isBlockedProvider(runtime: ModelRuntime, providerId: string): boolean {
  if (providerId === "anthropic" || providerId.startsWith("radius")) return true;
  // models.json 里另起名字的 Radius 网关:认它们专用的 pi-messages 协议。
  return runtime.getModels(providerId).some((model) => (model.api as string) === "pi-messages");
}

/**
 * 下架的登录方式(Claude 订阅、Radius 网关)以前登过的,凭据还留在 auth.json 里:界面上看不到,
 * 也就退不掉,只剩一份没人用的 refresh token。启动时清掉(只删本机凭据,不联网)。
 */
export async function retireBlockedLogins(): Promise<string[]> {
  const runtime = await oauthRuntime();
  const retired: string[] = [];
  for (const provider of runtime.getProviders()) {
    if (!isBlockedProvider(runtime, provider.id)) continue;
    if (!runtime.isUsingOAuth(provider.id) || !runtime.hasConfiguredAuth(provider.id)) continue;
    await runtime.logout(provider.id);
    retired.push(provider.id);
  }
  if (retired.length) resetOAuthRuntime();
  return retired;
}

/** 用 API Key 接入的官方订阅:OpenCode Go 会员在 opencode.ai 控制台领 Key。 */
const API_KEY_PROVIDERS = ["opencode-go"] as const;
type ApiKeyProviderId = (typeof API_KEY_PROVIDERS)[number];

function isApiKeyProvider(providerId: string): providerId is ApiKeyProviderId {
  return (API_KEY_PROVIDERS as readonly string[]).includes(providerId);
}

export const API_KEY_PROVIDER_HELP: Record<ApiKeyProviderId, { keyUrl: string; hint: string }> = {
  "opencode-go": {
    keyUrl: "https://opencode.ai/auth",
    hint: "在 OpenCode 控制台订阅 Go 后复制 API Key。请求直接发到 opencode.ai/zen/go,按 Go 会员额度计费。",
  },
};

export interface OAuthProviderInfo {
  id: string;
  name: string;
  authType: "oauth" | "api_key";
  loggedIn: boolean;
  modelCount: number;
  keyUrl?: string;
  hint?: string;
  /** 本机装了 OpenCode CLI 且已经存过这家的 Key:页面给「从本机 OpenCode 导入」。 */
  importable?: boolean;
}

export async function listOAuthProviders(): Promise<OAuthProviderInfo[]> {
  const runtime = await oauthRuntime();
  const out: OAuthProviderInfo[] = [];
  for (const provider of runtime.getProviders()) {
    if (isBlockedProvider(runtime, provider.id)) continue;
    if (isApiKeyProvider(provider.id)) {
      const loggedIn = runtime.hasConfiguredAuth(provider.id);
      out.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        authType: "api_key",
        loggedIn,
        modelCount: loggedIn ? (await providerModels(runtime, provider.id)).length : 0,
        ...API_KEY_PROVIDER_HELP[provider.id],
        importable: Boolean(readOpenCodeCliKey(provider.id)),
      });
      continue;
    }
    const auth = (provider as unknown as { auth?: { oauth?: unknown } }).auth;
    if (!auth?.oauth) continue;
    const loggedIn = runtime.isUsingOAuth(provider.id) && runtime.hasConfiguredAuth(provider.id);
    out.push({
      id: provider.id,
      name: provider.name ?? provider.id,
      authType: "oauth",
      loggedIn,
      modelCount: loggedIn ? runtime.getModels(provider.id).length : 0,
    });
  }
  // 常用的放前面:ChatGPT、OpenCode Go、Copilot。
  const rank = (id: string) => ["openai-codex", "opencode-go", "github-copilot"].indexOf(id);
  return out.sort((a, b) => {
    const ra = rank(a.id);
    const rb = rank(b.id);
    if (ra !== -1 || rb !== -1) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    return a.name.localeCompare(b.name);
  });
}

export interface ProxyModel {
  /** 对外的模型 id:`<provider>/<model>`,代理靠它找回是哪一家。 */
  id: string;
  name: string;
  contextWindow: number;
  supportsImage: boolean;
}

/** 已登录的订阅账号下能用的模型,供模型代理与供应商登记使用。 */
export async function loggedInModels(): Promise<ProxyModel[]> {
  const runtime = await oauthRuntime();
  const providers = await listOAuthProviders();
  const models: ProxyModel[] = [];
  for (const provider of providers.filter((p) => p.loggedIn)) {
    for (const model of await providerModels(runtime, provider.id)) {
      const input = (model as unknown as { input?: string[] }).input ?? [];
      models.push({
        id: `${provider.id}/${model.id}`,
        name: `${model.name ?? model.id} · ${provider.name}`,
        contextWindow: model.contextWindow || 128_000,
        supportsImage: input.includes("image"),
      });
    }
  }
  return models;
}

/**
 * 代理收到 `<provider>/<model>` 时找回模型。OpenCode Go 只认页面上列出的那份(官方列表,去掉下线的,
 * MiniMax / Qwen 已改走 Anthropic 接口);直接查 pi 的表会绕开这些修正。
 */
export async function resolveProxyModel(providerId: string, modelId: string) {
  const runtime = await oauthRuntime();
  if (providerId === OPENCODE_GO) {
    return (await providerModels(runtime, providerId)).find((model) => model.id === modelId);
  }
  return runtime.getModel(providerId, modelId);
}

// -- 登录流程 ----------------------------------------------------------------
//
// 登录是一场对话:pi 会 notify(授权链接 / 设备码 / 进度),偶尔 prompt(要你粘一个
// 码或选一项)。页面轮询 flow 状态把这些画出来;要答的走 answer。

interface LoginFlow {
  id: string;
  provider: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  events: Array<Record<string, unknown>>;
  prompt: {
    id: string;
    type: string;
    message: string;
    placeholder?: string;
    options?: unknown;
  } | null;
  resolvePrompt: ((value: string) => void) | null;
  error?: string;
  abort: AbortController;
}

const flows = new Map<string, LoginFlow>();

/** 浏览器授权页关了不点取消,pi 的登录会一直挂着、还按家排队;超时后放掉,这家才能再登。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * OpenCode CLI 自己存的 Key(`opencode auth login` / TUI 里 `/connect`):
 * `$XDG_DATA_HOME/opencode/auth.json`,默认 `~/.local/share/opencode/auth.json`,
 * 形如 `{"opencode-go": {"type": "api", "key": "..."}}`。Zen 与 Go 共用同一把控制台 Key。
 */
export function readOpenCodeCliKey(providerId: string): string | null {
  const dataHome = process.env["XDG_DATA_HOME"]?.trim() || join(homedir(), ".local", "share");
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataHome, "opencode", "auth.json"), "utf8"),
    ) as Record<string, { type?: unknown; key?: unknown } | undefined>;
    for (const id of [providerId, "opencode"]) {
      const entry = parsed[id];
      if (entry?.type === "api" && typeof entry.key === "string" && entry.key.trim())
        return entry.key.trim();
    }
  } catch {
    // 没装或没登过 OpenCode
  }
  return null;
}

export async function startOAuthLogin(
  providerId: string,
  onDone: () => void,
  options: { importFromOpenCodeCli?: boolean } = {},
): Promise<string> {
  for (const [id, flow] of flows) {
    if (flow.status !== "running" && Date.now() - flow.startedAt > 30 * 60_000) flows.delete(id);
    // 同一家重新点登录:上一次没走完的直接作废,不然会排在它后面一直等。
    if (flow.status === "running" && flow.provider === providerId) flow.abort.abort();
  }
  const runtime = await oauthRuntime();
  if (isBlockedProvider(runtime, providerId) || !runtime.getProvider(providerId)) {
    throw new OAuthRequestError(`不支持用这种方式登录:${providerId}`);
  }
  const authType = isApiKeyProvider(providerId) ? "api_key" : "oauth";
  const importedKey = options.importFromOpenCodeCli ? readOpenCodeCliKey(providerId) : null;
  if (options.importFromOpenCodeCli && !importedKey)
    throw new OAuthRequestError("本机 OpenCode 里没有找到这家的 API Key");
  const flow: LoginFlow = {
    id: randomUUID(),
    provider: providerId,
    status: "running",
    startedAt: Date.now(),
    events: [],
    prompt: null,
    resolvePrompt: null,
    abort: new AbortController(),
  };
  flows.set(flow.id, flow);
  const timeout = setTimeout(() => {
    if (flow.status === "running") {
      flow.error = "登录超时(10 分钟没有完成),请重新点登录";
      flow.abort.abort();
    }
  }, LOGIN_TIMEOUT_MS);
  timeout.unref();
  const interaction: AuthInteraction = {
    signal: flow.abort.signal,
    prompt: (prompt: AuthPrompt) =>
      new Promise<string>((resolve, reject) => {
        if (importedKey && prompt.type === "secret") {
          resolve(importedKey);
          return;
        }
        const p = prompt as unknown as {
          type: string;
          message: string;
          placeholder?: string;
          options?: unknown;
        };
        flow.prompt = {
          id: randomUUID(),
          type: p.type,
          message: p.message,
          placeholder: p.placeholder,
          options: p.options,
        };
        flow.resolvePrompt = (value) => {
          flow.prompt = null;
          flow.resolvePrompt = null;
          resolve(value);
        };
        flow.abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
        // manual_code 提示和本机回调服务器是赛跑关系:浏览器回跳先到,pi 会撤掉这个提示,
        // 页面上的「粘贴授权码」输入框也要跟着消失。
        prompt.signal?.addEventListener(
          "abort",
          () => {
            flow.prompt = null;
            flow.resolvePrompt = null;
            reject(new Error("prompt superseded"));
          },
          { once: true },
        );
      }),
    notify: (event) => {
      flow.events.push({ ...(event as unknown as Record<string, unknown>), at: Date.now() });
    },
  };
  void runtime
    .login(providerId, authType, interaction)
    .then(() => {
      flow.prompt = null;
      flow.status = "done";
      resetOAuthRuntime();
      onDone();
    })
    .catch((error: unknown) => {
      flow.prompt = null;
      const timedOut = Boolean(flow.error);
      flow.status = flow.abort.signal.aborted && !timedOut ? "cancelled" : "error";
      if (!timedOut) flow.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => clearTimeout(timeout));
  return flow.id;
}

/** 还在进行中的登录:页面刷新后能找回来继续、或者取消。 */
export function listOAuthFlows(): Array<{ id: string; provider: string; startedAt: number }> {
  return [...flows.values()]
    .filter((flow) => flow.status === "running")
    .map((flow) => ({ id: flow.id, provider: flow.provider, startedAt: flow.startedAt }));
}

export function getOAuthFlow(flowId: string) {
  const flow = flows.get(flowId);
  if (!flow) return null;
  return {
    id: flow.id,
    provider: flow.provider,
    status: flow.status,
    events: flow.events,
    prompt: flow.prompt,
    error: flow.error ?? null,
  };
}

export function answerOAuthFlow(flowId: string, value: string): boolean {
  const flow = flows.get(flowId);
  if (!flow?.resolvePrompt) return false;
  flow.resolvePrompt(value);
  return true;
}

export function cancelOAuthFlow(flowId: string): boolean {
  const flow = flows.get(flowId);
  if (!flow) return false;
  flow.abort.abort();
  return true;
}

export async function logoutOAuth(providerId: string): Promise<void> {
  const runtime = await oauthRuntime();
  await runtime.logout(providerId);
  resetOAuthRuntime();
}
