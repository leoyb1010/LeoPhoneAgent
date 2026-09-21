import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { leoPath } from "./leoPaths.js";

/**
 * [leo] 订阅账号登录(OAuth):Claude Pro/Max、ChatGPT(Codex)、GitHub Copilot 等。
 *
 * 用 pi 的 ModelRuntime —— 它负责每家的授权流程(浏览器回跳 / 设备码)、token
 * 存储与过期刷新,以及每家接口的细节(Claude 订阅的 beta 头、Codex 的专用端点、
 * Copilot 的 token 交换)。凭据只落在本机 `~/.leoagent/oauth/auth.json`,不出机器。
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
  if (!process.env["PI_PACKAGE_DIR"] && packagedPiDir && existsSync(join(packagedPiDir, "package.json"))) {
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

/** 凭据文件变了(登录 / 退出)就重建,它自己不监听文件。 */
export function resetOAuthRuntime(): void {
  runtimePromise = null;
}

export interface OAuthProviderInfo {
  id: string;
  name: string;
  loggedIn: boolean;
  modelCount: number;
}

export async function listOAuthProviders(): Promise<OAuthProviderInfo[]> {
  const runtime = await oauthRuntime();
  const out: OAuthProviderInfo[] = [];
  for (const provider of runtime.getProviders()) {
    const auth = (provider as unknown as { auth?: { oauth?: unknown } }).auth;
    if (!auth?.oauth) continue;
    const loggedIn = runtime.isUsingOAuth(provider.id) && runtime.hasConfiguredAuth(provider.id);
    out.push({
      id: provider.id,
      name: provider.name ?? provider.id,
      loggedIn,
      modelCount: loggedIn ? runtime.getModels(provider.id).length : 0,
    });
  }
  // 常用的放前面:Claude、ChatGPT、Copilot。
  const rank = (id: string) => ["anthropic", "openai-codex", "github-copilot"].indexOf(id);
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
    for (const model of runtime.getModels(provider.id)) {
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
  prompt: { id: string; type: string; message: string; placeholder?: string; options?: unknown } | null;
  resolvePrompt: ((value: string) => void) | null;
  error?: string;
  abort: AbortController;
}

const flows = new Map<string, LoginFlow>();

export async function startOAuthLogin(providerId: string, onDone: () => void): Promise<string> {
  for (const [id, flow] of flows) {
    if (flow.status !== "running" && Date.now() - flow.startedAt > 30 * 60_000) flows.delete(id);
  }
  const runtime = await oauthRuntime();
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
  const interaction: AuthInteraction = {
    signal: flow.abort.signal,
    prompt: (prompt: AuthPrompt) =>
      new Promise<string>((resolve, reject) => {
        const p = prompt as unknown as { type: string; message: string; placeholder?: string; options?: unknown };
        flow.prompt = { id: randomUUID(), type: p.type, message: p.message, placeholder: p.placeholder, options: p.options };
        flow.resolvePrompt = (value) => {
          flow.prompt = null;
          flow.resolvePrompt = null;
          resolve(value);
        };
        flow.abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
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
    .login(providerId, "oauth", interaction)
    .then(() => {
      flow.prompt = null;
      flow.status = "done";
      resetOAuthRuntime();
      onDone();
    })
    .catch((error: unknown) => {
      flow.prompt = null;
      flow.status = flow.abort.signal.aborted ? "cancelled" : "error";
      flow.error = error instanceof Error ? error.message : String(error);
    });
  return flow.id;
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
