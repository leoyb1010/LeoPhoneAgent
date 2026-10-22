#!/usr/bin/env node
// [up3-runtime] 藏宝阁 MCP 的 stdio 兼容垫片。
//
// 1.15 起藏宝阁改成 Host 本机 HTTP MCP 端点(http://127.0.0.1:38473/api/leo/treasury/mcp),
// LeoBot 自己的 CLI 配置启动时就换成了 http 条目;但外部 agent(Codex、Claude Code、Cursor、
// OpenCode)的配置里还写着「用 LeoBot Helper 以 ELECTRON_RUN_AS_NODE=1 跑 Resources/leo/treasury-mcp.mjs」。
// 这个脚本留在原路径,把 stdio 上逐行的 JSON-RPC 原样转给 Host 端点,回包再逐行写回,
// 那些配置不用改就能继续用。没有依赖:纯 Node,ELECTRON_RUN_AS_NODE 下照样跑。
//
// 环境(与旧配置一致):
//   LEOAGENT_KEY   藏宝阁钥匙(Host 登记 http 条目时用的同一把,~/.leoagent/treasury.key)。
//                  不设时依次读 $LEOAGENT_HOME/treasury.key、$LEOAGENT_HOME/key。
//   LEOAGENT_PORT  本机接口端口,默认 38473。
//   LEOAGENT_HOME  默认 ~/.leoagent。
// 钥匙只进 Authorization 头,不写日志。
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PORT = Number(process.env.LEOAGENT_PORT) || 38473;
const ENDPOINT_PATH = "/api/leo/treasury/mcp";
const LEO_HOME = process.env.LEOAGENT_HOME?.trim() || join(homedir(), ".leoagent");
// 本机端点不会慢到这个程度;只防 Host 卡死时客户端永远挂着。
const REQUEST_TIMEOUT_MS = 120_000;

let protocolVersion;
let sessionId;

function key() {
  const fromEnv = process.env.LEOAGENT_KEY?.trim();
  if (fromEnv) return fromEnv;
  // LeoBot 第一次启动才生成钥匙文件,所以每次请求现读,不在启动时缓存空值。
  for (const name of ["treasury.key", "key"]) {
    try {
      const value = readFileSync(join(LEO_HOME, name), "utf8").trim();
      if (value.length >= 16) return value;
    } catch {
      // 没有这个文件就试下一个。
    }
  }
  return "";
}

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
// 客户端先关掉自己那端时 stdout 会 EPIPE;对方已经不在,安静退出,不往 stderr 甩堆栈。
process.stdout.on("error", () => process.exit(0));
const log = (text) => process.stderr.write(`[leo-treasury shim] ${text}\n`);
const replyError = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

function post(body) {
  return new Promise((resolve, reject) => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": Buffer.byteLength(body),
    };
    const bearer = key();
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    // 用 node:http 而不是 fetch:不吃 HTTP(S)_PROXY / NODE_USE_ENV_PROXY,回环地址一定直连。
    const req = request(
      { host: "127.0.0.1", port: PORT, path: ENDPOINT_PATH, method: "POST", headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            sessionId: res.headers["mcp-session-id"],
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Streamable HTTP 的 SSE 回包:每个事件的 data 行拼起来是一条 JSON-RPC 消息。 */
function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) messages.push(JSON.parse(data));
  }
  return messages;
}

function failureMessage(status, text) {
  if (status === 401 || status === 403) {
    return `LeoBot 拒绝了藏宝阁钥匙(${status})。打开一次新版 LeoBot 让它重新登记,或检查配置里的 LEOAGENT_KEY 是否等于 ~/.leoagent/treasury.key。`;
  }
  if (status === 404) {
    return "这个 LeoBot 没有藏宝阁 MCP 端点(/api/leo/treasury/mcp),请升级到 1.15 及以上。";
  }
  return `LeoBot 本机接口返回 HTTP ${status}: ${text.slice(0, 200)}`;
}

async function forward(message) {
  const isRequest =
    message.method !== undefined && message.id !== undefined && message.id !== null;
  let response;
  try {
    response = await post(JSON.stringify(message));
  } catch (error) {
    const reason = error?.code || error?.message || String(error);
    log(`connect failed: ${reason}`);
    if (isRequest) {
      replyError(
        message.id,
        -32000,
        `连不上 LeoBot 本机接口 127.0.0.1:${PORT}(${reason})。LeoBot 没在运行?打开 LeoBot 后重试。`,
      );
    }
    return;
  }
  if (typeof response.sessionId === "string" && response.sessionId) sessionId = response.sessionId;

  let replies = [];
  try {
    if (response.contentType.includes("text/event-stream")) replies = parseSse(response.text);
    else if (response.text.trim()) {
      const parsed = JSON.parse(response.text);
      replies = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    replies = [];
  }
  replies = replies.filter(
    (reply) => reply && typeof reply === "object" && ("result" in reply || "error" in reply),
  );

  if (response.status >= 200 && response.status < 300) {
    for (const reply of replies) {
      if (message.method === "initialize" && reply.id === message.id) {
        protocolVersion = reply.result?.protocolVersion ?? protocolVersion;
      }
      write(reply);
    }
    if (isRequest && replies.length === 0) {
      replyError(message.id, -32603, `LeoBot 本机接口没有返回结果(HTTP ${response.status})`);
    }
    return;
  }

  log(`http ${response.status} for ${String(message.method)}`);
  if (!isRequest) return;
  // Host 自己回的 JSON-RPC 错误(例如 -32700)带着 id 时原样转回,其余合成一条清楚的错误。
  const own = replies.find((reply) => reply.id === message.id && reply.error);
  if (own) write(own);
  else replyError(message.id, -32000, failureMessage(response.status, response.text));
}

function handleLine(line) {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    replyError(null, -32700, "parse error");
    return;
  }
  // 2025-06-18 起 MCP 已不用批量;旧客户端真发数组时逐条转发。
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!message || typeof message !== "object") {
      replyError(null, -32600, "invalid request");
      continue;
    }
    void forward(message);
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", handleLine);
