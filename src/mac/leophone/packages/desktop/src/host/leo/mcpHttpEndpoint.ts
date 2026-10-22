import type { IncomingMessage, ServerResponse } from "node:http";

import { createBrainMcpServer } from "./brainTools.js";
import { createTreasuryMcpServer } from "./treasuryTools.js";
import type { TreasuryStore } from "./treasuryStore.js";

/**
 * [leo] 本机 HTTP 接口上的无状态 MCP 端点(Streamable HTTP,只回 application/json)。
 *
 * 为什么:藏宝阁 / 第二大脑以前各是一个 stdio MCP 子进程,每个 workspace 的 CLI 各拉一份
 * (Electron Helper 当 node 跑,约 85 MB + 65 MB)。工具实现本来就在 Host 里(藏宝阁)或只是转发
 * HTTP(第二大脑),改成 Host 上的 HTTP 端点后所有 workspace 共用,CLI 不再起子进程。
 *
 * 协议面只做 CLI 用到的那一小块:
 * - POST 单条 JSON-RPC。请求回 200 + JSON 响应;通知 / 客户端回包回 202 空体。
 * - `initialize` 回显客户端请求的协议版本;`server/discover`(2026-07-28 新协议的探测)回
 *   -32601,SDK 按「旧协议 server」退回 initialize。
 * - 不发 session id、不开 SSE:GET / DELETE 回 405,SDK 按规范当作「没有服务端推送流」。
 */

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

export interface McpHttpServer {
  name: string;
  version: string;
  instructions?: string;
  listTools(): readonly McpToolDescriptor[];
  /** 抛出的异常回成 JSON-RPC -32603;工具层面的失败应自己返回 `isError: true`。 */
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) {
        reject(new JsonRpcError(-32600, "request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function dispatch(server: McpHttpServer, message: JsonRpcMessage): Promise<unknown> {
  const params = asRecord(message.params);
  switch (message.method) {
    case "initialize": {
      const requested = params["protocolVersion"];
      return {
        protocolVersion:
          typeof requested === "string" && requested ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: server.listTools() };
    case "tools/call": {
      const name = params["name"];
      if (typeof name !== "string" || !server.listTools().some((tool) => tool.name === name)) {
        throw new JsonRpcError(-32602, `unknown tool: ${String(name)}`);
      }
      return server.callTool(name, asRecord(params["arguments"]));
    }
    default:
      throw new JsonRpcError(-32601, `method not found: ${String(message.method)}`);
  }
}

/** 调用方已经做完鉴权。 */
export async function handleMcpHttpRequest(
  server: McpHttpServer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const send = (status: number, payload?: unknown) => {
    if (payload === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }

  let message: JsonRpcMessage;
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      send(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "expected a single JSON-RPC message" },
      });
      return;
    }
    message = parsed as JsonRpcMessage;
  } catch (error) {
    const reason = error instanceof JsonRpcError ? error.message : "parse error";
    send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: reason } });
    return;
  }

  // 通知(没有 id)和客户端对服务端请求的回包(没有 method):收下即可。
  const hasId = typeof message.id === "string" || typeof message.id === "number";
  if (!hasId || typeof message.method !== "string") {
    send(202);
    return;
  }

  try {
    const result = await dispatch(server, message);
    send(200, { jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    const code = error instanceof JsonRpcError ? error.code : -32603;
    const text = error instanceof Error ? error.message : String(error);
    send(200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  }
}

/** 本机接口上的 MCP 端点:路径 → 服务。藏宝阁钥匙能开的只有这几条加 `/api/leo/treasury/*`。 */
export function leoMcpEndpoints(
  store: TreasuryStore,
  brain: McpHttpServer = createBrainMcpServer(),
): ReadonlyMap<string, McpHttpServer> {
  return new Map([
    ["/api/leo/treasury/mcp", createTreasuryMcpServer(store)],
    ["/api/leo/brain/mcp", brain],
  ]);
}
