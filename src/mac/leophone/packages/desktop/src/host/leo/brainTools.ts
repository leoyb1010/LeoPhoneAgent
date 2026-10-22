import { openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { ZCODE_VERSION } from "@zcode/shared";

import { BRAIN_TOOLS, TOOL_BUDGET_MS } from "./brainToolDefs.js";
import type { McpCallToolResult, McpHttpServer } from "./mcpHttpEndpoint.js";
import { PROFILE_CARD_TITLE } from "./profileCard.js";

/**
 * [leo] 第二大脑(leo-brain)的九个工具,由 Host 的本机 MCP 端点 `/api/leo/brain/mcp` 提供。
 * 原先是每个 workspace 一个的 stdio 子进程 `leo/brain-mcp.mjs`,这里是它的移植:工具名、参数和
 * 返回形状不变(参考实现是网关随附的 leo_brain_mcp.py);描述补了「什么时候用」。
 *
 * - 本机 agent key 在 `~/.config/leo-brain/leobot-mac.key`(0600),**每次请求时**读,只放进
 *   Authorization 头;不写进 MCP 配置、不进日志、不进返回内容。
 * - 网关地址 `LEO_BRAIN_URL`(Host 进程环境),默认 Cloudflare 隧道。
 * - 工具定义和每个工具的总时限在 brainToolDefs.ts;Host 这边的网关请求比时限早 HOST_MARGIN_MS
 *   收手,模型拿到的是具体的「超时 / HTTP 错误」而不是 CLI 的通用超时。
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

interface CallInit {
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: boolean;
  /** 单次网关请求的秒数上限;同时受整个工具调用的时限约束。 */
  timeout?: number;
}
type Call = (method: string, path: string, init?: CallInit) => Promise<unknown>;
interface ToolContext {
  call: Call;
  /** CLI 在 tools/call 的 `_meta` 里带来的当前工作区(绝对路径);没有就是 undefined。 */
  workspace: string | undefined;
}

/** Host 比 CLI 的时限早这么多收手。 */
const HOST_MARGIN_MS = 5_000;
const ASK_MAX_WAIT_SECONDS = 45;

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

/** CLI 在 tools/call 的 `_meta` 里带当前工作区(adapters/src/mcp/index.ts mcpRequestMeta)。 */
function workspaceFromMeta(meta: Record<string, unknown>): string | undefined {
  const context = meta["com.zcode/request-context"];
  const candidates = [
    meta["workspace_path"],
    context && typeof context === "object" ? (context as Json)["workspace_path"] : undefined,
  ];
  return candidates.find(
    (value): value is string => typeof value === "string" && isAbsolute(value),
  );
}

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

  async function request(
    deadline: number,
    method: string,
    path: string,
    init: CallInit = {},
  ): Promise<unknown> {
    let url = base + path;
    if (init.params) {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(init.params)) {
        if (value !== undefined && value !== null && value !== "")
          query.append(name, String(value));
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
    const timeoutMs = Math.min((init.timeout ?? 40) * 1000, deadline - Date.now());
    if (timeoutMs <= 0)
      throw new BrainError(`连不上第二大脑网关 ${base}：超时（这次调用的时限已用完）`);
    const timeout = Math.round(timeoutMs / 1000);
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
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

  const tools: Record<string, (a: Args, ctx: ToolContext) => Promise<unknown>> = {
    brain_brief: (_a, { call }) => call("GET", "/v1/brief"),
    brain_search: (a, { call }) =>
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
    brain_media_search: (a, { call }) =>
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
    brain_read: async (a, { call }) => {
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
    brain_media_get: async (a, { call }) => {
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
    brain_link: (a, { call }) =>
      call("POST", "/v1/links", {
        body: {
          items: strArray(need(a, "refs")).map((ref) => ({
            id: refId(ref),
            variant: a["variant"] ?? "thumb",
          })),
          ttl_hours: a["ttl_hours"] ?? null,
        },
      }),
    brain_ask: (a, { call }) => {
      // 网关最多等 wait 秒;再留 10 s 网络余量,都在本工具 60 s 时限之内。
      const requested = Number(a["wait_seconds"] ?? 25);
      const wait = Number.isFinite(requested)
        ? Math.max(0, Math.min(requested, ASK_MAX_WAIT_SECONDS))
        : 25;
      if (a["id"])
        return call("GET", `/v1/answers/${seg(a["id"])}`, {
          params: { wait },
          timeout: wait + 10,
        });
      const refs = strArray(a["refs"]);
      const fileIds = refs.filter((ref) => ref.startsWith("file:")).map(refId);
      const recordRefs = refs.filter((ref) => ref.includes(":") && !ref.startsWith("file:"));
      return call("POST", "/v1/ask", {
        params: { wait },
        timeout: wait + 10,
        body: {
          question: need(a, "question"),
          mode: a["mode"] ?? "answer",
          include_private: Boolean(a["include_private"]),
          file_ids: fileIds.length ? fileIds : null,
          record_refs: recordRefs.length ? recordRefs : null,
        },
      });
    },
    brain_save_card: async (a, { call }) => {
      const title = String(need(a, "title"));
      if (title.trim() === PROFILE_CARD_TITLE) {
        throw new BrainError(
          `标题「${PROFILE_CARD_TITLE}」留给 iPhone 维护的用户画像卡，agent 不能用这个标题存卡；换一个标题再存。`,
        );
      }
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
          title,
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
    brain_upload: async (a, { call, workspace }) => {
      // Host 进程的 cwd 是 "/",相对路径只能按 CLI 带来的工作区解析;拿不到工作区就要求绝对路径。
      const given = expandHome(String(need(a, "path")));
      if (!isAbsolute(given) && !workspace) {
        throw new BrainError(`需要绝对路径：${given}（拿不到当前工作区，没法解析相对路径）`);
      }
      const path = isAbsolute(given) ? given : resolve(workspace!, given);
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
      return call("POST", "/v1/inbox", { body: await openAsBlob(path), headers, timeout: 325 });
    },
  };

  return {
    name: "leo-brain",
    version: VERSION,
    instructions:
      "Leo 的第二大脑：问题涉及 Leo 本人、他的项目、之前的工作或资料时直接 brain_search（不必先 brain_brief），照片视频用 brain_media_search；需要原文用 brain_read，回答注明标题；给 Leo 的链接只用 web_url 或 brain_link 生成的签名链接。",
    listTools: () => BRAIN_TOOLS,
    async callTool(name, args, meta = {}): Promise<McpCallToolResult> {
      const tool = tools[name];
      if (!tool) throw new Error(`未知工具 ${name}`);
      const deadline = Date.now() + (TOOL_BUDGET_MS.get(name) ?? 45_000) - HOST_MARGIN_MS;
      const call: Call = (method, path, init) => request(deadline, method, path, init);
      let out: unknown;
      try {
        out = await tool(args, { call, workspace: workspaceFromMeta(meta) });
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
