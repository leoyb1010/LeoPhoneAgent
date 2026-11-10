import type {
  LeoBrainCardSummary,
  LeoBrainFileChunk,
  LeoBrainSearchItem,
  LeoBrainSearchScope,
  LeoBrainWorkspaceErrorCode,
  LeoBrainWorkspaceRequest,
  LeoBrainWorkspaceResult,
} from "@zcode/shared";

import { BrainHttpError, openBrainGateway, type BrainGateway } from "./brainGateway.js";

/**
 * [leo] 第二大脑工作区的 Host 业务 owner：只读适配（契约见 docs/specs/leo-brain-workspace.md）。
 *
 * 根因：首页只有一张计数卡片。要在 Mac 上浏览、搜索、阅读第二大脑，又不能让界面拿到 key、
 * 不能开放任意网关路径。所以由这里统一做三件事：请求按固定 op 在运行时校验（不信任 TS 类型），
 * 每次请求现开网关（换 key 后立即生效，不复用 readBrainStatus 的 5 分钟缓存），
 * 结果只投影需要的字段，错误按 code 分类。不写盘、不缓存、不记录正文、不调任何模型。
 */

const MAX_OFFSET = 100_000;
const MAX_QUERY_CHARS = 200;
const MAX_ID_CHARS = 200;
const CARD_PAGE = 50;
const SEARCH_PAGE = 20;
const CHUNK_PAGE = 12;
const CARD_BODY_PAGE_CHARS = 20_000;
const SCOPES: readonly LeoBrainSearchScope[] = ["all", "files", "cards"];

class WorkspaceError extends Error {
  readonly code: LeoBrainWorkspaceErrorCode;
  constructor(code: LeoBrainWorkspaceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const invalidRequest = (message: string) => new WorkspaceError("invalid_request", message);
const invalidResponse = () => new WorkspaceError("invalid_response", "第二大脑返回的数据格式不对");

// ---- 请求校验 ---------------------------------------------------------------

function readOffset(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_OFFSET)
    throw invalidRequest("offset 不合法");
  return raw;
}

function readId(raw: unknown): string {
  // id 会编码进网关路径：拒绝分隔符、查询符、百分号和控制字符，不让调用方构造任意路径。
  if (typeof raw !== "string") throw invalidRequest("id 不合法");
  const id = raw.trim();
  if (
    id.length === 0 ||
    id.length > MAX_ID_CHARS ||
    id === "." ||
    id === ".." ||
    /[/\\?#%\u0000-\u001f\u007f]/.test(id)
  )
    throw invalidRequest("id 不合法");
  return id;
}

export function parseBrainWorkspaceRequest(body: unknown): LeoBrainWorkspaceRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidRequest("请求格式不对");
  const raw = body as Record<string, unknown>;
  switch (raw["op"]) {
    case "status":
      return { op: "status" };
    case "cards":
      return { op: "cards", offset: readOffset(raw["offset"]) };
    case "search": {
      if (typeof raw["query"] !== "string") throw invalidRequest("搜索词不能为空");
      const query = raw["query"].trim();
      if (query.length === 0 || query.length > MAX_QUERY_CHARS) throw invalidRequest("搜索词长度不合法");
      const scope = raw["scope"] === undefined ? "all" : raw["scope"];
      if (!SCOPES.includes(scope as LeoBrainSearchScope)) throw invalidRequest("搜索范围不合法");
      return { op: "search", query, scope: scope as LeoBrainSearchScope, offset: readOffset(raw["offset"]) };
    }
    case "read": {
      const kind = raw["kind"];
      if (kind !== "card" && kind !== "file") throw invalidRequest("阅读类型不合法");
      return { op: "read", kind, id: readId(raw["id"]), offset: readOffset(raw["offset"]) };
    }
    default:
      throw invalidRequest("不支持的操作");
  }
}

// ---- 响应解码（只取需要的字段；可选字段类型不对就丢掉，必填缺失 → invalid_response）-----

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Json;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value;
}
function reqStr(value: unknown): string {
  if (typeof value !== "string") throw invalidResponse();
  return value;
}
function reqCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalidResponse();
  return value;
}
function optStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/** 只放进有值的可选字段，结果里不出现 undefined 键。 */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function cardSummary(raw: unknown): LeoBrainCardSummary {
  const r = obj(raw);
  return compact({
    id: reqStr(r["id"]),
    title: reqStr(r["title"]),
    category: optStr(r["category"]),
    status: optStr(r["status"]),
    version: optNum(r["version"]),
    updatedAt: optStr(r["updated_at"]),
    summary: optStr(r["summary"]),
  });
}

function searchItem(raw: unknown): LeoBrainSearchItem {
  const r = obj(raw);
  const type = r["type"];
  if (type !== "file" && type !== "card") throw invalidResponse();
  const match = r["match"] && typeof r["match"] === "object" ? (r["match"] as Json) : undefined;
  const matchOut = match ? compact({ locator: optStr(match["locator"]), excerpt: optStr(match["excerpt"]) }) : undefined;
  return compact({
    type,
    id: reqStr(r["id"]),
    title: reqStr(r["title"]),
    path: optStr(r["path"]),
    source: optStr(r["source"]),
    ext: optStr(r["ext"]),
    category: optStr(r["category"]),
    project: optStr(r["project"]),
    privacy: optStr(r["privacy"]),
    status: optStr(r["status"]),
    score: optNum(r["score"]),
    size: optNum(r["size"]),
    mtime: optStr(r["mtime"]),
    match: matchOut && Object.keys(matchOut).length > 0 ? matchOut : undefined,
  });
}

function fileChunk(raw: unknown): LeoBrainFileChunk {
  const r = obj(raw);
  return compact({
    id: String(typeof r["id"] === "number" ? r["id"] : reqStr(r["id"])),
    locator: optStr(r["locator"]),
    text: reqStr(r["text"]),
    method: optStr(r["method"]),
  });
}

/** 按字符切页，不切开 UTF-16 代理对。 */
function sliceBody(body: string, offset: number): { text: string; next: number | null } {
  if (offset >= body.length) return { text: "", next: null };
  let end = Math.min(body.length, offset + CARD_BODY_PAGE_CHARS);
  const last = body.charCodeAt(end - 1);
  if (end < body.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: body.slice(offset, end), next: end < body.length ? end : null };
}

// ---- 执行 -------------------------------------------------------------------

async function fetchJson(
  gateway: BrainGateway,
  path: string,
  params?: Record<string, string | number>,
): Promise<unknown> {
  let value: unknown;
  try {
    value = await gateway.getJson(path, params);
  } catch (error) {
    if (error instanceof BrainHttpError) {
      if (error.status === 401) throw new WorkspaceError("unauthorized", "第二大脑的 key 已失效");
      if (error.status === 403) throw new WorkspaceError("forbidden", "没有访问这条内容的权限");
      if (error.status === 404) throw new WorkspaceError("not_found", "内容不存在");
      throw new WorkspaceError("unreachable", "第二大脑暂时连不上");
    }
    // response.json() 解析失败是格式问题，其余（超时、断网）是连不上。
    if (error instanceof SyntaxError) throw invalidResponse();
    throw new WorkspaceError("unreachable", "第二大脑暂时连不上");
  }
  // openBrainGateway 把 404 映射成 null。
  if (value === null) throw new WorkspaceError("not_found", "内容不存在");
  return value;
}

async function run(
  gateway: BrainGateway,
  request: LeoBrainWorkspaceRequest,
): Promise<LeoBrainWorkspaceResult> {
  switch (request.op) {
    case "status": {
      const archive = obj(obj(await fetchJson(gateway, "/v1/health"))["archive"] ?? {});
      const count = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : null);
      return { ok: true, data: { op: "status", cards: count(archive["cards"]), files: count(archive["files"]) } };
    }
    case "cards": {
      const offset = request.offset ?? 0;
      const page = obj(await fetchJson(gateway, "/v1/cards", { offset, limit: CARD_PAGE }));
      const items = list(page["items"]).map(cardSummary);
      const total = reqCount(page["total"]);
      const next = offset + items.length;
      return {
        ok: true,
        data: { op: "cards", items, total, offset, nextOffset: items.length > 0 && next < total ? next : null },
      };
    }
    case "search": {
      const offset = request.offset ?? 0;
      const scope = request.scope ?? "all";
      // 固定 include_private=0：工作区不自动请求私密资料。
      const page = obj(
        await fetchJson(gateway, "/v1/search", {
          q: request.query,
          scope,
          limit: SEARCH_PAGE,
          offset,
          include_private: 0,
        }),
      );
      const rawNext = page["next_offset"];
      const nextOffset =
        typeof rawNext === "number" && Number.isInteger(rawNext) && rawNext > offset ? rawNext : null;
      return {
        ok: true,
        data: compact({
          op: "search" as const,
          query: request.query,
          scope,
          items: list(page["items"]).map(searchItem),
          total: reqCount(page["total"]),
          mode: optStr(page["mode"]),
          semanticUsed: typeof page["semantic_used"] === "boolean" ? page["semantic_used"] : undefined,
          hiddenSensitive: optNum(page["hidden_sensitive"]) ?? 0,
          offset,
          nextOffset,
        }),
      };
    }
    case "read":
      return request.kind === "card" ? readCard(gateway, request.id, request.offset ?? 0) : readFile(gateway, request.id, request.offset ?? 0);
  }
}

async function readCard(gateway: BrainGateway, id: string, offset: number): Promise<LeoBrainWorkspaceResult> {
  const card = obj(await fetchJson(gateway, `/v1/cards/${encodeURIComponent(id)}`));
  const body = reqStr(card["body"]);
  const page = sliceBody(body, offset);
  const sources = Array.isArray(card["sources"])
    ? card["sources"].flatMap((raw) => {
        const r = raw && typeof raw === "object" ? (raw as Json) : {};
        return typeof r["file_id"] === "string" ? [compact({ fileId: r["file_id"], locator: optStr(r["locator"]) })] : [];
      })
    : [];
  return {
    ok: true,
    data: compact({
      op: "read" as const,
      kind: "card" as const,
      id: reqStr(card["id"]),
      title: reqStr(card["title"]),
      category: optStr(card["category"]),
      status: optStr(card["status"]),
      version: optNum(card["version"]),
      createdAt: optStr(card["created_at"]),
      updatedAt: optStr(card["updated_at"]),
      body: page.text,
      bodyOffset: offset,
      bodyLength: body.length,
      nextOffset: page.next,
      sources,
    }),
  };
}

async function readFile(gateway: BrainGateway, id: string, offset: number): Promise<LeoBrainWorkspaceResult> {
  const encoded = encodeURIComponent(id);
  const file = obj(await fetchJson(gateway, `/v1/files/${encoded}`));
  const chunkPage = obj(await fetchJson(gateway, `/v1/files/${encoded}/chunks`, { offset, limit: CHUNK_PAGE }));
  const chunks = list(chunkPage["chunks"]).map(fileChunk);
  const total = reqCount(chunkPage["total"]);
  const next = offset + chunks.length;
  return {
    ok: true,
    data: compact({
      op: "read" as const,
      kind: "file" as const,
      id: reqStr(file["id"]),
      title: reqStr(file["title"]),
      path: optStr(file["path"]),
      source: optStr(file["source"]),
      ext: optStr(file["ext"]),
      size: optNum(file["size"]),
      mtime: optStr(file["mtime"]),
      category: optStr(file["category"]),
      project: optStr(file["project"]),
      privacy: optStr(file["privacy"]),
      status: optStr(file["status"]),
      summary: optStr(file["summary"]),
      chunkTotal: optNum(file["chunk_total"]) ?? total,
      originalAvailable: file["original_available"] === true,
      backupAvailable: file["backup_available"] === true,
      chunks,
      chunkOffset: offset,
      nextOffset: chunks.length > 0 && next < total ? next : null,
    }),
  };
}

/** 路由入口：任何失败都折成结构化错误，不回传 HTTP 原文、URL 或 key。 */
export async function queryBrainWorkspace(
  body: unknown,
  options: { open?: () => Promise<BrainGateway | null> } = {},
): Promise<LeoBrainWorkspaceResult> {
  try {
    const request = parseBrainWorkspaceRequest(body);
    // 每次都现开网关：用户换了 key 或刚配置好，重试马上生效。
    const gateway = await (options.open ?? (() => openBrainGateway()))();
    if (!gateway) return { ok: false, error: { code: "not_configured", message: "这台 Mac 还没有配置第二大脑" } };
    return await run(gateway, request);
  } catch (error) {
    if (error instanceof WorkspaceError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "invalid_response", message: "第二大脑返回的数据格式不对" } };
  }
}
