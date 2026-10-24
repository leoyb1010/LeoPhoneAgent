import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { McpHttpServer, McpToolDescriptor } from "./mcpHttpEndpoint.js";

/**
 * [leo] 生图工具 leo-media(Host 本机 MCP 端点 `/api/leo/media/mcp`)。
 *
 * 生图模型(grok-imagine-image、gemini-*-image、gpt-image…)不会调工具,也不在对话内核的
 * 流式协议里(内核不认 assistant 的 image 块),所以不能当聊天模型用。改成一个工具:
 * 对话模型照常干活,要出图时调 generate_image,用已配置供应商的同一个网关去生成,
 * 图存到 `~/.leophoneagent/media/YYYY-MM-DD/`,回给模型可直接贴进回答的 Markdown
 * (聊天里绝对路径图片会内联显示,可点开大图)。
 *
 * 两种网关形状都认:
 * - `POST {base}/images/generations`(OpenAI 风格,`data[].b64_json` / `data[].url`);
 * - `POST {base}/chat/completions`(OpenRouter / CLIProxyAPI 风格,`message.images[].image_url.url`,
 *   或 content 里的 data URL)。Gemini 系先走这条。
 */

export interface MediaProvider {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** 这个供应商已添加的模型(用来就近选生图模型)。 */
  readonly modelIds: readonly string[];
}

export interface MediaToolDeps {
  readonly providers: () => Promise<readonly MediaProvider[]>;
  readonly fetch?: typeof globalThis.fetch;
  readonly outputDir?: string;
  readonly now?: () => Date;
}

const IMAGE_MODEL = /(?:^|[-_/.])(?:image|imagen|imagine|dall-e)(?:$|[-_/.\d])|gpt-image/iu;
// 没指定模型时的偏好:质量与速度都好的在前;都没有就用接口列出的第一个生图模型。
const PREFERRED = [/gpt-image/iu, /gemini.*image/iu, /imagine-image-quality/iu, /imagine-image/iu];
const TIMEOUT_MS = 180_000;

export const MEDIA_TOOLS: readonly McpToolDescriptor[] = [
  {
    name: "generate_image",
    description:
      "用已配置的生图模型生成图片（文生图）。用户要画图、做插画/海报/图标/配图、「生成一张…的图」时调用。" +
      "返回保存后的本地路径和可直接放进回答的 Markdown 图片语法——把它原样写进回答，图片会在聊天里内联显示。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "画面描述，越具体越好（主体、风格、构图、光线、比例）" },
        model: { type: "string", description: "生图模型 ID；不填则自动选一个已配置或网关提供的生图模型" },
        size: { type: "string", description: "尺寸，如 1024x1024、1536x1024（部分模型忽略）" },
        n: { type: "integer", minimum: 1, maximum: 4, default: 1 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    _meta: { timeoutMs: TIMEOUT_MS + 10_000 },
  },
];

type Image = { readonly data: Buffer; readonly ext: string } | { readonly url: string };

export function isImageModelId(modelId: string): boolean {
  return IMAGE_MODEL.test(modelId);
}

function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  return /\/v1$/iu.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function pickPreferred(ids: readonly string[]): string | undefined {
  const images = ids.filter(isImageModelId);
  for (const pattern of PREFERRED) {
    const hit = images.find((id) => pattern.test(id) && !/video/iu.test(id));
    if (hit) return hit;
  }
  return images.find((id) => !/video/iu.test(id));
}

async function listGatewayModels(provider: MediaProvider, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const response = await fetchImpl(`${apiBase(provider.baseUrl)}/models`, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).flatMap((item) => (typeof item.id === "string" ? [item.id] : []));
  } catch {
    return [];
  }
}

function authHeaders(provider: MediaProvider): Record<string, string> {
  const key = provider.apiKey?.trim();
  return {
    "content-type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...provider.headers,
  };
}

/** 选供应商与模型:指定了模型就找添加过它的供应商;否则先看已添加的生图模型,再问网关列表。 */
export async function resolveImageTarget(
  providers: readonly MediaProvider[],
  requested: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ provider: MediaProvider; model: string } | null> {
  const model = requested?.trim();
  if (model) {
    const owner = providers.find((provider) => provider.modelIds.includes(model)) ?? providers[0];
    return owner ? { provider: owner, model } : null;
  }
  for (const provider of providers) {
    const configured = pickPreferred(provider.modelIds);
    if (configured) return { provider, model: configured };
  }
  for (const provider of providers) {
    const listed = pickPreferred(await listGatewayModels(provider, fetchImpl));
    if (listed) return { provider, model: listed };
  }
  return null;
}

function fromDataUrl(url: string): Image | null {
  const match = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(url.trim());
  if (!match) return null;
  const ext = match[1]!.toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");
  return { data: Buffer.from(match[2]!, "base64"), ext };
}

/** 从两种响应形状里把图片取出来;认不出就返回空数组。 */
export function extractImages(body: unknown): Image[] {
  const images: Image[] = [];
  const record = (body ?? {}) as Record<string, unknown>;
  for (const item of Array.isArray(record["data"]) ? record["data"] : []) {
    const entry = item as Record<string, unknown>;
    if (typeof entry["b64_json"] === "string") {
      images.push({ data: Buffer.from(entry["b64_json"], "base64"), ext: sniffExt(entry["b64_json"]) });
    } else if (typeof entry["url"] === "string") {
      images.push(fromDataUrl(entry["url"]) ?? { url: entry["url"] });
    }
  }
  for (const choice of Array.isArray(record["choices"]) ? record["choices"] : []) {
    const message = ((choice as Record<string, unknown>)["message"] ?? {}) as Record<string, unknown>;
    for (const item of Array.isArray(message["images"]) ? message["images"] : []) {
      const url = ((item as Record<string, unknown>)["image_url"] as { url?: unknown } | undefined)?.url;
      if (typeof url === "string") images.push(fromDataUrl(url) ?? { url });
    }
    const content = message["content"];
    const parts = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
    for (const part of parts) {
      const text =
        typeof part === "string"
          ? part
          : typeof (part as { image_url?: { url?: unknown } }).image_url?.url === "string"
            ? String((part as { image_url: { url: string } }).image_url.url)
            : "";
      for (const match of text.matchAll(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/giu)) {
        const image = fromDataUrl(match[0]);
        if (image) images.push(image);
      }
    }
  }
  return images;
}

function sniffExt(base64: string): string {
  if (base64.startsWith("/9j/")) return "jpg";
  if (base64.startsWith("iVBOR")) return "png";
  if (base64.startsWith("UklGR")) return "webp";
  if (base64.startsWith("R0lGOD")) return "gif";
  return "png";
}

async function postJson(
  url: string,
  provider: MediaProvider,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: authHeaders(provider),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}: ${text.slice(0, 300)}` };
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateImages(
  deps: MediaToolDeps,
  input: { prompt: string; model?: string; size?: string; n?: number },
): Promise<{ model: string; provider: string; paths: string[]; urls: string[] }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const target = await resolveImageTarget(await deps.providers(), input.model, fetchImpl);
  if (!target) {
    throw new Error("没有可用的生图模型：在设置 → 模型供应商里添加一个生图模型（如 gemini-3.1-flash-image、grok-imagine-image），或在 model 参数里指定。");
  }
  const { provider, model } = target;
  const base = apiBase(provider.baseUrl);
  const n = Math.min(Math.max(Math.trunc(input.n ?? 1), 1), 4);
  const viaImages = () =>
    postJson(`${base}/images/generations`, provider, {
      model,
      prompt: input.prompt,
      n,
      response_format: "b64_json",
      ...(input.size ? { size: input.size } : {}),
    }, fetchImpl);
  const viaChat = () =>
    postJson(`${base}/chat/completions`, provider, {
      model,
      messages: [{ role: "user", content: input.size ? `${input.prompt}\n\n(尺寸 ${input.size})` : input.prompt }],
      modalities: ["image", "text"],
    }, fetchImpl);
  const order = /gemini/iu.test(model) ? [viaChat, viaImages] : [viaImages, viaChat];
  const errors: string[] = [];
  let images: Image[] = [];
  for (const attempt of order) {
    const result = await attempt();
    if (!result.ok) {
      errors.push(result.message);
      continue;
    }
    images = extractImages(result.body);
    if (images.length > 0) break;
    errors.push("响应里没有图片");
  }
  if (images.length === 0) throw new Error(`${model} 生图失败：${errors.join("；")}`);

  const now = (deps.now ?? (() => new Date()))();
  const pad = (value: number) => String(value).padStart(2, "0");
  // 按本机时间分目录、命名(用户在 Finder 里按日期找)。
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dir = join(deps.outputDir ?? join(homedir(), ".leophoneagent", "media"), day);
  mkdirSync(dir, { recursive: true });
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const paths: string[] = [];
  const urls: string[] = [];
  images.forEach((image, index) => {
    if ("url" in image) {
      urls.push(image.url);
      return;
    }
    const path = join(dir, `${stamp}-${index + 1}.${image.ext}`);
    writeFileSync(path, image.data);
    paths.push(path);
  });
  return { model, provider: provider.name, paths, urls };
}

export function createMediaMcpServer(deps: MediaToolDeps): McpHttpServer {
  return {
    name: "leo-media",
    version: "1.0.0",
    listTools: () => MEDIA_TOOLS,
    async callTool(name, args) {
      if (name !== "generate_image") {
        return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
      }
      const input = (args ?? {}) as Record<string, unknown>;
      const prompt = typeof input["prompt"] === "string" ? input["prompt"].trim() : "";
      if (!prompt) return { content: [{ type: "text", text: "prompt 不能为空" }], isError: true };
      try {
        const result = await generateImages(deps, {
          prompt,
          ...(typeof input["model"] === "string" ? { model: input["model"] } : {}),
          ...(typeof input["size"] === "string" ? { size: input["size"] } : {}),
          ...(typeof input["n"] === "number" ? { n: input["n"] } : {}),
        });
        const alt = prompt.replace(/[[\]\n]/gu, " ").slice(0, 60);
        const markdown = [...result.paths, ...result.urls].map((ref) => `![${alt}](<${ref}>)`).join("\n\n");
        return {
          content: [
            {
              type: "text",
              text: [
                `已用 ${result.model}（${result.provider}）生成 ${result.paths.length + result.urls.length} 张图。`,
                result.paths.length ? `保存在：\n${result.paths.join("\n")}` : "",
                `把下面的 Markdown 原样写进回答，图片会在聊天里显示：\n\n${markdown}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  };
}
