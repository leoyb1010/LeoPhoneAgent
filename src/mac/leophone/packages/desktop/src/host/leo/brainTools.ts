import { openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { ZCODE_VERSION } from "@zcode/shared";

import type { McpCallToolResult, McpHttpServer, McpToolDescriptor } from "./mcpHttpEndpoint.js";

/**
 * [leo] 第二大脑(leo-brain)的九个工具,由 Host 的本机 MCP 端点 `/api/leo/brain/mcp` 提供。
 * 原先是每个 workspace 一个的 stdio 子进程 `leo/brain-mcp.mjs`,这里是它的原样移植:工具名、描述、
 * 参数和返回形状不变(参考实现是网关随附的 leo_brain_mcp.py)。
 *
 * - 本机 agent key 在 `~/.config/leo-brain/leobot-mac.key`(0600),**每次请求时**读,只放进
 *   Authorization 头;不写进 MCP 配置、不进日志、不进返回内容。
 * - 网关地址 `LEO_BRAIN_URL`(Host 进程环境),默认 Cloudflare 隧道。
 */

const VERSION = "1.0.0";
const DEFAULT_BASE = "https://wenjian.leoyuan.top";
const PUBLIC = process.env["LEO_BRAIN_PUBLIC"] || DEFAULT_BASE;

export function defaultBrainKeyFile(home: string = homedir()): string {
  return join(home, ".config", "leo-brain", "leobot-mac.key");
}

const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

class BrainError extends Error {}

type Args = Record<string, unknown>;
type Json = Record<string, unknown>;

export interface BrainToolsOptions {
  keyFile?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

const HINTS: Record<number, string> = {
  401: "（key 无效或已吊销）",
  403: "（权限不足）",
  404: "（不存在）",
  409: "（处理中，稍后重试）",
  429: "（请求过快，稍后重试）",
};

const refId = (ref: string) => (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref);
const seg = (value: unknown) => encodeURIComponent(String(value));
function need(args: Args, name: string): unknown {
  if (args[name] === undefined || args[name] === null) throw new BrainError(`缺少参数 ${name}`);
  return args[name];
}
const str = (value: unknown) => (typeof value === "string" ? value : "");
const strArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const REF = { type: "string", description: "结果里的 ref，例如 file:ab12…、card:…、memory:…" };

const TOOL_DEFS: Array<[string, string, Json, string[]]> = [
  ["brain_brief", "先调用这个：返回本 key 的权限、资料规模与推荐用法（纯文本）。", {}, []],
  [
    "brain_search",
    "在 Leo 的第二大脑里一次检索文档、知识卡、照片、视频和记忆，返回紧凑结果（标题/日期/摘要/定位/web_url/缩略图链接），按类型分组。",
    {
      query: { type: "string" },
      include_private: { type: "boolean", description: "包含私密资料（家庭照片、个人记录）" },
      kind: { type: "string", enum: ["all", "document", "card", "image", "video"] },
      limit: { type: "integer", default: 12 },
      offset: { type: "integer", default: 0 },
      group: { type: "boolean", default: true },
    },
    ["query"],
  ],
  [
    "brain_media_search",
    "用自然语言找照片或视频（人物、时间、地点、场景，如「去年夏天布布在海边」）。返回理解后的条件和紧凑结果，含签名缩略图/播放链接。",
    {
      query: { type: "string" },
      kind: { type: "string", enum: ["all", "photo", "video"] },
      year: { type: "string" },
      limit: { type: "integer", default: 12 },
      offset: { type: "integer", default: 0 },
    },
    ["query"],
  ],
  [
    "brain_read",
    "读一份资料或知识卡的原文片段（按 locator 定位，带分页）。",
    {
      ref: REF,
      locator: { type: "string" },
      offset: { type: "integer", default: 0 },
      max_chars: { type: "integer", default: 6000 },
    },
    ["ref"],
  ],
  [
    "brain_media_get",
    "取一张照片或一段视频的详情：Gemini 描述、标签、画面分段、语音转写、可打开的链接；include_image=true 时附带缩略图供看图。",
    {
      ref: REF,
      include_image: { type: "boolean", default: false },
      segments_offset: { type: "integer", default: 0 },
    },
    ["ref"],
  ],
  [
    "brain_link",
    "为资料生成可直接在手机/浏览器打开的签名链接；variant: thumb/preview（24h）、video（6h）、raw 原件（1h）、web 网页深链。",
    {
      refs: { type: "array", items: { type: "string" } },
      variant: { type: "string", enum: ["thumb", "preview", "video", "raw", "web"] },
      ttl_hours: { type: "number" },
    },
    ["refs"],
  ],
  [
    "brain_ask",
    "基于原文证据回答问题（每个结论带 [n] 引用与 web_url）。最多等 wait_seconds；没完成会返回 id，再传 id 继续等。",
    {
      question: { type: "string" },
      id: { type: "string", description: "继续等待之前的回答" },
      include_private: { type: "boolean" },
      mode: { type: "string", enum: ["answer", "analyze", "prepare"] },
      refs: { type: "array", items: { type: "string" } },
      wait_seconds: { type: "integer", default: 25 },
    },
    [],
  ],
  [
    "brain_save_card",
    "把结论存成草稿知识卡（不会自动确认，Leo 会在审阅队列里看）。",
    {
      title: { type: "string" },
      body: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: { ref: { type: "string" }, locator: { type: "string" } },
        },
      },
      category: { type: "string" },
      idempotency_key: { type: "string" },
    },
    ["title", "body"],
  ],
  [
    "brain_upload",
    "把本机一个文件存进第二大脑收件箱（自动解析、向量化、提炼；相同内容不重复保存）。",
    { path: { type: "string" }, name: { type: "string" }, idempotency_key: { type: "string" } },
    ["path"],
  ],
];

export const BRAIN_TOOLS: readonly McpToolDescriptor[] = TOOL_DEFS.map(
  ([name, description, properties, required]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required },
  }),
);

const NOTE = "提示：OCR、转写、模型描述可能有误，只当线索；发给 Leo 的链接用 web_url 或签名 url。";

export function createBrainMcpServer(options: BrainToolsOptions = {}): McpHttpServer {
  const keyFile = expandHome(options.keyFile ?? defaultBrainKeyFile());
  const base = (options.baseUrl ?? (process.env["LEO_BRAIN_URL"] || DEFAULT_BASE)).replace(
    /\/+$/,
    "",
  );
  const doFetch = options.fetch ?? globalThis.fetch;
  // Cloudflare 会拦掉没有正常 User-Agent 的请求(Node fetch 默认只发 "node")。
  const userAgent = `LeoBotMac/${ZCODE_VERSION} leo-brain-mcp/${VERSION}`;

  const key = async () => {
    try {
      return (await readFile(keyFile, "utf8")).trim();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new BrainError(`读不到第二大脑 key 文件 ${keyFile}：${code || String(error)}`);
    }
  };

  async function call(
    method: string,
    path: string,
    init: {
      params?: Record<string, unknown>;
      body?: unknown;
      headers?: Record<string, string>;
      raw?: boolean;
      timeout?: number;
    } = {},
  ): Promise<unknown> {
    let url = base + path;
    if (init.params) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(init.params)) {
        if (value !== undefined && value !== null && value !== "") query.append(name, String(value));
      }
      url += `?${query}`;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await key()}`,
      "User-Agent": userAgent,
    };
    let body: Blob | string | undefined;
    if (init.body instanceof Blob) body = init.body;
    else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] = "application/json";
    }
    Object.assign(headers, init.headers ?? {});
    const timeout = init.timeout ?? 40;
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeout * 1000),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      const err = error as { name?: string; message?: string; cause?: { code?: string } };
      const reason =
        err?.name === "TimeoutError" ? `超时（${timeout}s）` : err?.cause?.code || err?.message;
      throw new BrainError(`连不上第二大脑网关 ${base}：${reason}`);
    }
    const payload = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      let message = `HTTP Error ${response.status}: ${response.statusText}`;
      try {
        message = (JSON.parse(payload.toString("utf8")) as { error?: string }).error || message;
      } catch {
        // 不是 JSON 就用状态行。
      }
      throw new BrainError(`HTTP ${response.status} ${message}${HINTS[response.status] ?? ""}`);
    }
    if (init.raw) return payload;
    const type = (response.headers.get("content-type") || "").split(";")[0]!.trim();
    return type === "application/json"
      ? JSON.parse(payload.toString("utf8"))
      : payload.toString("utf8");
  }

  const tools: Record<string, (a: Args) => Promise<unknown>> = {
    brain_brief: () => call("GET", "/v1/brief"),
    brain_search: (a) =>
      call("GET", "/v1/search", {
        params: {
          q: need(a, "query"),
          view: "compact",
          group: (a["group"] ?? true) ? "1" : "",
          include_private: a["include_private"] ? "1" : "",
          kind: a["kind"] || "all",
          limit: a["limit"] ?? 12,
          offset: a["offset"] ?? 0,
          max_chars: a["max_chars"] ?? 9000,
        },
      }),
    brain_media_search: (a) =>
      call("GET", "/v1/media/search", {
        params: {
          q: need(a, "query"),
          kind: a["kind"] ?? "all",
          year: a["year"] ?? "",
          limit: a["limit"] ?? 12,
          offset: a["offset"] ?? 0,
          view: "compact",
        },
      }),
    brain_read: async (a) => {
      const ref = String(need(a, "ref"));
      const [kind, ident] = ref.includes(":")
        ? [ref.slice(0, ref.indexOf(":")), refId(ref)]
        : ["file", ref];
      const offset = Number(a["offset"] ?? 0);
      const maxChars = Number(a["max_chars"] ?? 6000);
      if (kind === "card") {
        const d = (await call("GET", `/v1/cards/${seg(ident)}`)) as Json;
        const body = str(d["body"]);
        const more = body.length > offset + maxChars;
        return {
          ref,
          title: d["title"],
          status: d["status"],
          version: d["version"],
          text: body.slice(offset, offset + maxChars),
          truncated: more,
          next_offset: more ? offset + maxChars : null,
          sources: (Array.isArray(d["sources"]) ? d["sources"] : []).slice(0, 20),
        };
      }
      if (kind !== "file") return call("GET", `/v1/records/${seg(kind)}/${seg(ident)}`);
      const meta = (await call("GET", `/v1/files/${seg(ident)}`)) as Json;
      const d = (await call("GET", `/v1/files/${seg(ident)}/chunks`, {
        params: { offset, limit: a["chunks"] ?? 6, locator: a["locator"] },
      })) as { chunks: Array<{ locator: unknown; text: string }>; total: number };
      let budget = maxChars;
      const out: Array<{ locator: unknown; text: string }> = [];
      for (const chunk of d.chunks) {
        if (budget <= 0) break;
        out.push({ locator: chunk.locator, text: chunk.text.slice(0, budget) });
        budget -= chunk.text.length;
      }
      const next = offset + out.length;
      return {
        ref: `file:${ident}`,
        title: meta["title"],
        privacy: meta["privacy"],
        summary: meta["summary"],
        chunks: out,
        chunk_total: d.total,
        next_offset: next < d.total ? next : null,
      };
    },
    brain_media_get: async (a) => {
      const ident = refId(String(need(a, "ref")));
      const d = await call("GET", `/v1/media/${seg(ident)}`, {
        params: { view: "compact", segments_offset: a["segments_offset"] ?? 0 },
      });
      const content: Array<Record<string, unknown>> = [{ type: "text", text: JSON.stringify(d) }];
      if (a["include_image"]) {
        const image = (await call("GET", `/v1/media/${seg(ident)}/thumbnail`, {
          raw: true,
        })) as Buffer;
        content.push({ type: "image", mimeType: "image/jpeg", data: image.toString("base64") });
      }
      return content;
    },
    brain_link: (a) =>
      call("POST", "/v1/links", {
        body: {
          items: strArray(need(a, "refs")).map((ref) => ({
            id: refId(ref),
            variant: a["variant"] ?? "thumb",
          })),
          ttl_hours: a["ttl_hours"] ?? null,
        },
      }),
    brain_ask: (a) => {
      if (a["id"])
        return call("GET", `/v1/answers/${seg(a["id"])}`, {
          params: { wait: a["wait_seconds"] ?? 25 },
        });
      const refs = strArray(a["refs"]);
      const fileIds = refs.filter((ref) => ref.startsWith("file:")).map(refId);
      const recordRefs = refs.filter((ref) => ref.includes(":") && !ref.startsWith("file:"));
      return call("POST", "/v1/ask", {
        params: { wait: a["wait_seconds"] ?? 25 },
        body: {
          question: need(a, "question"),
          mode: a["mode"] ?? "answer",
          include_private: Boolean(a["include_private"]),
          file_ids: fileIds.length ? fileIds : null,
          record_refs: recordRefs.length ? recordRefs : null,
        },
      });
    },
    brain_save_card: async (a) => {
      const sources = (Array.isArray(a["sources"]) ? a["sources"] : [])
        .map((source) => (source && typeof source === "object" ? (source as Json) : {}))
        .filter((source) => str(source["ref"]).startsWith("file:"))
        .map((source) => ({
          file_id: refId(str(source["ref"])),
          locator: str(source["locator"]) || "来源材料",
        }));
      const idempotencyKey = str(a["idempotency_key"]);
      const d = (await call("POST", "/v1/cards", {
        body: {
          title: need(a, "title"),
          body: need(a, "body"),
          sources,
          category: a["category"] || "个人知识",
          status: "draft",
        },
        ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
      })) as Json;
      return {
        id: d["id"],
        version: d["version"],
        status: d["status"],
        web_url: `${PUBLIC}/#card/${String(d["id"])}`,
      };
    },
    brain_upload: async (a) => {
      const path = expandHome(String(need(a, "path")));
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new BrainError(`文件不存在：${path}`);
      if (info.size > 256 * 1024 * 1024) throw new BrainError("超过 256MB，请直接放进收件箱目录");
      const headers: Record<string, string> = {
        "X-Filename": encodeURIComponent(str(a["name"]) || basename(path)),
        "X-Dedupe": "1",
      };
      const idempotencyKey = str(a["idempotency_key"]);
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      // 按文件流式上传:Host 是常驻进程,不能为一次上传把整个文件读进内存。
      return call("POST", "/v1/inbox", { body: await openAsBlob(path), headers, timeout: 300 });
    },
  };

  return {
    name: "leo-brain",
    version: VERSION,
    instructions:
      "Leo 的第二大脑：先 brain_brief，再 brain_search / brain_media_search；需要原文用 brain_read；给 Leo 的链接只用 web_url 或 brain_link 生成的签名链接。",
    listTools: () => BRAIN_TOOLS,
    async callTool(name, args): Promise<McpCallToolResult> {
      const tool = tools[name];
      if (!tool) throw new Error(`未知工具 ${name}`);
      let out: unknown;
      try {
        out = await tool(args);
      } catch (error) {
        if (!(error instanceof BrainError) && !(error instanceof TypeError)) throw error;
        return { content: [{ type: "text", text: `失败：${error.message}` }], isError: true };
      }
      if (Array.isArray(out)) return { content: out as Array<Record<string, unknown>> };
      const text = typeof out === "string" ? out : JSON.stringify(out);
      return {
        content: [{ type: "text", text: name === "brain_brief" ? text : `${text}\n${NOTE}` }],
      };
    },
  };
}
