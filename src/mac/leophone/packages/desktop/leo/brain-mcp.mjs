#!/usr/bin/env node
// [leo] 第二大脑 MCP 服务(stdio, JSON-RPC 2.0, 无依赖)。参考实现是服务端随附的 leo_brain_mcp.py,
// 工具名、描述、参数和返回形状保持一致。所有读写都用本机这把 agent 自己的 key 走网关 HTTP,
// 和其它客户端一样按权限范围鉴权、记审计。
//
//   LEO_BRAIN_KEY       key 本身(可选,登记时不用它:用户 MCP 配置所有 agent 都读得到)
//   LEO_BRAIN_KEY_FILE  0600 的 key 文件,默认 ~/.config/leo-brain/leobot-mac.key
//   LEO_BRAIN_URL       网关地址,默认 https://wenjian.leoyuan.top(Cloudflare 隧道)
//
// key 只放进 Authorization 头,绝不写进日志或返回内容。
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "1.0.0";
const BASE = (process.env.LEO_BRAIN_URL || "https://wenjian.leoyuan.top").replace(/\/+$/, "");
const PUBLIC = process.env.LEO_BRAIN_PUBLIC || "https://wenjian.leoyuan.top";
const expandHome = (path) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
const KEY_FILE = expandHome(
  process.env.LEO_BRAIN_KEY_FILE || join(homedir(), ".config/leo-brain/leobot-mac.key"),
);

class BrainError extends Error {}

async function key() {
  if (process.env.LEO_BRAIN_KEY?.trim()) return process.env.LEO_BRAIN_KEY.trim();
  try {
    return (await readFile(KEY_FILE, "utf8")).trim();
  } catch (error) {
    throw new BrainError(`读不到第二大脑 key 文件 ${KEY_FILE}：${error.code || error.message}`);
  }
}

// Cloudflare 会拦掉没有正常 User-Agent 的请求(Node fetch 默认只发 "node")。
// 版本取自宿主 App 的 Info.plist(ELECTRON_RUN_AS_NODE 下 execPath 是 Contents/MacOS/LeoBot)。
// 开发态用 node 直接跑没有 Info.plist,版本记为 dev。
const PLIST_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/;
let userAgent;
function getUserAgent() {
  userAgent ??= readFile(join(dirname(process.execPath), "..", "Info.plist"), "utf8")
    .then(
      (plist) => PLIST_VERSION.exec(plist)?.[1] ?? "dev",
      () => "dev",
    )
    .then((appVersion) => `LeoBotMac/${appVersion} leo-brain-mcp/${VERSION}`);
  return userAgent;
}

const HINTS = {
  401: "（key 无效或已吊销）",
  403: "（权限不足）",
  404: "（不存在）",
  409: "（处理中，稍后重试）",
  429: "（请求过快，稍后重试）",
};

async function call(method, path, { params, body, headers, raw = false, timeout = 40 } = {}) {
  let url = BASE + path;
  if (params) {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") query.append(name, String(value));
    }
    url += `?${query}`;
  }
  const h = { Authorization: `Bearer ${await key()}`, "User-Agent": await getUserAgent() };
  let data;
  if (Buffer.isBuffer(body)) data = body;
  else if (body !== undefined) {
    data = JSON.stringify(body);
    h["Content-Type"] = "application/json";
  }
  Object.assign(h, headers ?? {});
  let response;
  try {
    const init = { method, headers: h, signal: AbortSignal.timeout(timeout * 1000) };
    if (data !== undefined) init.body = data;
    response = await fetch(url, init);
  } catch (error) {
    const reason =
      error?.name === "TimeoutError" ? `超时（${timeout}s）` : error?.cause?.code || error?.message;
    throw new BrainError(`连不上第二大脑网关 ${BASE}：${reason}`);
  }
  const payload = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    let message = `HTTP Error ${response.status}: ${response.statusText}`;
    try {
      message = JSON.parse(payload.toString("utf8")).error || message;
    } catch {
      // 不是 JSON 就用状态行。
    }
    throw new BrainError(`HTTP ${response.status} ${message}${HINTS[response.status] ?? ""}`);
  }
  if (raw) return payload;
  const type = (response.headers.get("content-type") || "").split(";")[0].trim();
  return type === "application/json"
    ? JSON.parse(payload.toString("utf8"))
    : payload.toString("utf8");
}

const refId = (ref) => (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref);
const seg = (value) => encodeURIComponent(String(value));
function need(args, name) {
  if (args[name] === undefined || args[name] === null) throw new BrainError(`缺少参数 ${name}`);
  return args[name];
}

// ---------- tools ----------
async function tSearch(a) {
  return call("GET", "/v1/search", {
    params: {
      q: need(a, "query"),
      view: "compact",
      group: (a.group ?? true) ? "1" : "",
      include_private: a.include_private ? "1" : "",
      kind: a.kind || "all",
      limit: a.limit ?? 12,
      offset: a.offset ?? 0,
      max_chars: a.max_chars ?? 9000,
    },
  });
}

async function tMediaSearch(a) {
  return call("GET", "/v1/media/search", {
    params: {
      q: need(a, "query"),
      kind: a.kind ?? "all",
      year: a.year ?? "",
      limit: a.limit ?? 12,
      offset: a.offset ?? 0,
      view: "compact",
    },
  });
}

async function tRead(a) {
  const ref = String(need(a, "ref"));
  const [kind, ident] = ref.includes(":")
    ? [ref.slice(0, ref.indexOf(":")), refId(ref)]
    : ["file", ref];
  const offset = Number(a.offset ?? 0);
  const maxChars = Number(a.max_chars ?? 6000);
  if (kind === "card") {
    const d = await call("GET", `/v1/cards/${seg(ident)}`);
    const body = d.body ?? "";
    const more = body.length > offset + maxChars;
    return {
      ref,
      title: d.title,
      status: d.status,
      version: d.version,
      text: body.slice(offset, offset + maxChars),
      truncated: more,
      next_offset: more ? offset + maxChars : null,
      sources: (d.sources ?? []).slice(0, 20),
    };
  }
  if (kind !== "file") return call("GET", `/v1/records/${seg(kind)}/${seg(ident)}`);
  const meta = await call("GET", `/v1/files/${seg(ident)}`);
  const d = await call("GET", `/v1/files/${seg(ident)}/chunks`, {
    params: { offset, limit: a.chunks ?? 6, locator: a.locator },
  });
  let budget = maxChars;
  const out = [];
  for (const chunk of d.chunks) {
    if (budget <= 0) break;
    out.push({ locator: chunk.locator, text: chunk.text.slice(0, budget) });
    budget -= chunk.text.length;
  }
  const next = offset + out.length;
  return {
    ref: `file:${ident}`,
    title: meta.title,
    privacy: meta.privacy,
    summary: meta.summary,
    chunks: out,
    chunk_total: d.total,
    next_offset: next < d.total ? next : null,
  };
}

async function tMediaGet(a) {
  const ident = refId(String(need(a, "ref")));
  const d = await call("GET", `/v1/media/${seg(ident)}`, {
    params: { view: "compact", segments_offset: a.segments_offset ?? 0 },
  });
  const content = [{ type: "text", text: JSON.stringify(d) }];
  if (a.include_image) {
    const image = await call("GET", `/v1/media/${seg(ident)}/thumbnail`, { raw: true });
    content.push({ type: "image", mimeType: "image/jpeg", data: image.toString("base64") });
  }
  return content;
}

async function tLink(a) {
  return call("POST", "/v1/links", {
    body: {
      items: need(a, "refs").map((ref) => ({ id: refId(ref), variant: a.variant ?? "thumb" })),
      ttl_hours: a.ttl_hours ?? null,
    },
  });
}

async function tAsk(a) {
  if (a.id)
    return call("GET", `/v1/answers/${seg(a.id)}`, { params: { wait: a.wait_seconds ?? 25 } });
  const refs = a.refs ?? [];
  const fileIds = refs.filter((ref) => ref.startsWith("file:")).map(refId);
  const recordRefs = refs.filter((ref) => ref.includes(":") && !ref.startsWith("file:"));
  const body = {
    question: need(a, "question"),
    mode: a.mode ?? "answer",
    include_private: Boolean(a.include_private),
    file_ids: fileIds.length ? fileIds : null,
    record_refs: recordRefs.length ? recordRefs : null,
  };
  return call("POST", "/v1/ask", { params: { wait: a.wait_seconds ?? 25 }, body });
}

async function tSaveCard(a) {
  const sources = (a.sources ?? [])
    .filter((source) => (source?.ref ?? "").startsWith("file:"))
    .map((source) => ({ file_id: refId(source.ref), locator: source.locator || "来源材料" }));
  const headers = a.idempotency_key ? { "Idempotency-Key": a.idempotency_key } : undefined;
  const d = await call("POST", "/v1/cards", {
    body: {
      title: need(a, "title"),
      body: need(a, "body"),
      sources,
      category: a.category || "个人知识",
      status: "draft",
    },
    headers,
  });
  return { id: d.id, version: d.version, status: d.status, web_url: `${PUBLIC}/#card/${d.id}` };
}

async function tUpload(a) {
  const path = expandHome(String(need(a, "path")));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new BrainError(`文件不存在：${path}`);
  if (info.size > 256 * 1024 * 1024) throw new BrainError("超过 256MB，请直接放进收件箱目录");
  const headers = { "X-Filename": encodeURIComponent(a.name || basename(path)), "X-Dedupe": "1" };
  if (a.idempotency_key) headers["Idempotency-Key"] = a.idempotency_key;
  return call("POST", "/v1/inbox", { body: await readFile(path), headers, timeout: 300 });
}

const REF = { type: "string", description: "结果里的 ref，例如 file:ab12…、card:…、memory:…" };
const TOOLS = [
  [
    "brain_brief",
    "先调用这个：返回本 key 的权限、资料规模与推荐用法（纯文本）。",
    {},
    [],
    () => call("GET", "/v1/brief"),
  ],
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
    tSearch,
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
    tMediaSearch,
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
    tRead,
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
    tMediaGet,
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
    tLink,
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
    tAsk,
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
    tSaveCard,
  ],
  [
    "brain_upload",
    "把本机一个文件存进第二大脑收件箱（自动解析、向量化、提炼；相同内容不重复保存）。",
    { path: { type: "string" }, name: { type: "string" }, idempotency_key: { type: "string" } },
    ["path"],
    tUpload,
  ],
];
const BY_NAME = new Map(TOOLS.map((tool) => [tool[0], tool]));
const NOTE = "提示：OCR、转写、模型描述可能有误，只当线索；发给 Leo 的链接用 web_url 或签名 url。";

class MethodNotFound extends Error {}

async function handle(msg) {
  const { method, id } = msg;
  if (method === "initialize") {
    return {
      protocolVersion: msg.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "leo-brain", version: VERSION },
      instructions:
        "Leo 的第二大脑：先 brain_brief，再 brain_search / brain_media_search；需要原文用 brain_read；给 Leo 的链接只用 web_url 或 brain_link 生成的签名链接。",
    };
  }
  if (method === "tools/list") {
    return {
      tools: TOOLS.map(([name, description, properties, required]) => ({
        name,
        description,
        inputSchema: { type: "object", properties, required },
      })),
    };
  }
  if (method === "tools/call") {
    const params = msg.params ?? {};
    const tool = BY_NAME.get(params.name);
    if (!tool) throw new Error(`未知工具 ${params.name}`);
    let out;
    try {
      out = await tool[4](params.arguments ?? {});
    } catch (error) {
      if (!(error instanceof BrainError) && !(error instanceof TypeError)) throw error;
      return { content: [{ type: "text", text: `失败：${error.message}` }], isError: true };
    }
    if (Array.isArray(out)) return { content: out };
    const text = typeof out === "string" ? out : JSON.stringify(out);
    return {
      content: [{ type: "text", text: params.name === "brain_brief" ? text : `${text}\n${NOTE}` }],
    };
  }
  if (method === "ping") return {};
  if (id === undefined || id === null) return null; // 通知(initialized / cancelled)不用回
  throw new MethodNotFound(method);
}

const send = (reply) => process.stdout.write(`${JSON.stringify(reply)}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const result = await handle(msg);
    if (msg.id === undefined || msg.id === null) return;
    send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (error) {
    if (msg.id === undefined || msg.id === null) return;
    const notFound = error instanceof MethodNotFound;
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: notFound
        ? { code: -32601, message: `method not found: ${error.message}` }
        : { code: -32603, message: String(error?.message ?? error) },
    });
  }
});
