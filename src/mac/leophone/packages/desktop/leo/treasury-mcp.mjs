#!/usr/bin/env node
// [leo] 藏宝阁 MCP 服务(stdio)。它自己不碰数据库:所有读写都转给本机 127.0.0.1
// 的 Leo 接口,由 Window Host 里的那一份存储统一处理,避免两个进程抢同一个库。
//
// 需要的环境:LEOAGENT_KEY(或能读到 ~/.leoagent/key)、可选 LEOAGENT_PORT。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PORT = Number(process.env.LEOAGENT_PORT) || 38473;
const BASE = `http://127.0.0.1:${PORT}/api/leo/treasury`;
const KEY =
  process.env.LEOAGENT_KEY?.trim() ||
  (() => {
    try {
      return readFileSync(join(process.env.LEOAGENT_HOME || join(homedir(), ".leoagent"), "key"), "utf8").trim();
    } catch {
      return "";
    }
  })();

const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

let tools = [];

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "leo-treasury", version: "1.0.0" },
      });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      if (tools.length === 0) {
        const response = await fetch(`${BASE}/tools`, { headers });
        tools = (await response.json()).tools ?? [];
      }
      ok(id, { tools });
      return;
    }
    if (method === "tools/call") {
      const response = await fetch(`${BASE}/call/${params.name}`, {
        method: "POST",
        headers,
        body: JSON.stringify(params.arguments ?? {}),
      });
      const payload = await response.json();
      ok(id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
      return;
    }
    if (id !== undefined) fail(id, `unsupported method: ${method}`);
  } catch (error) {
    if (id !== undefined) fail(id, String(error));
  }
});
