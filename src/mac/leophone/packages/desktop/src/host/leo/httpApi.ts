import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { LEO_HTTP_PORT, leoLocalKey } from "./leoPaths.js";
import { executeTreasuryTool, TREASURY_TOOLS } from "./treasuryTools.js";
import type { TreasuryStore } from "./treasuryStore.js";
import type { TelegramChannel } from "./telegram.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

/**
 * [leo] 本机接口。只监听 127.0.0.1,只认 `~/.leoagent/key` 的 Bearer —— 藏宝阁的
 * MCP 子进程和桌面设置页用它;别的进程读不到那个文件就进不来。
 */
export function startLeoHttpApi(deps: {
  store: TreasuryStore;
  telegram: TelegramChannel;
  logger: Logger;
}): Server {
  const key = leoLocalKey();

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 4_000_000) req.destroy();
      });
      req.on("end", () => {
        try {
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });

  const json = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/leo/health") {
        json(res, 200, { ok: true, treasuryItems: deps.store.count(), telegram: deps.telegram.status() });
        return;
      }
      if (req.headers.authorization !== `Bearer ${key}`) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (url.pathname === "/api/leo/treasury/tools" && req.method === "GET") {
        json(res, 200, { tools: TREASURY_TOOLS });
        return;
      }
      if (url.pathname.startsWith("/api/leo/treasury/call/") && req.method === "POST") {
        const name = url.pathname.slice("/api/leo/treasury/call/".length);
        const body = await readBody(req);
        try {
          json(res, 200, executeTreasuryTool(deps.store, name, body));
        } catch (error) {
          json(res, 400, { error: String(error) });
        }
        return;
      }
      if (url.pathname === "/api/leo/telegram" && req.method === "GET") {
        json(res, 200, deps.telegram.status());
        return;
      }
      if (url.pathname === "/api/leo/telegram" && req.method === "PUT") {
        deps.telegram.update((await readBody(req)) as never);
        json(res, 200, deps.telegram.status());
        return;
      }
      if (url.pathname === "/api/leo/telegram/pairing" && req.method === "POST") {
        json(res, 200, { code: deps.telegram.newPairingCode() });
        return;
      }
      json(res, 404, { error: "not found" });
    })();
  });

  server.listen(LEO_HTTP_PORT, "127.0.0.1", () => {
    deps.logger.info(`[leo] local api on 127.0.0.1:${LEO_HTTP_PORT}`);
  });
  server.on("error", (error) => {
    // 端口被占(多开、或 2.x 还在跑)不该把 Host 带崩,记一笔就算。
    deps.logger.warn("[leo] local api failed to listen", { error: String(error) });
  });
  return server;
}
