import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { LEO_HTTP_PORT, leoLocalKey } from "./leoPaths.js";
import { createLeoPairingCode, leoLinkStatus } from "./link/index.js";
import { handleChatCompletions, handleModelsRequest } from "./modelProxy.js";
import { OAUTH_PAGE_HTML } from "./oauthPage.js";
import {
  answerOAuthFlow,
  cancelOAuthFlow,
  getOAuthFlow,
  listOAuthProviders,
  logoutOAuth,
  startOAuthLogin,
} from "./oauthRuntime.js";
import { executeTreasuryTool, TREASURY_TOOLS } from "./treasuryTools.js";
import type { TreasuryStore } from "./treasuryStore.js";

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

/**
 * [leo] 本机接口。只监听 127.0.0.1,只认 `~/.leoagent/key` 的 Bearer —— 藏宝阁的
 * MCP 子进程和桌面设置页用它;别的进程读不到那个文件就进不来。
 */
export function startLeoHttpApi(deps: {
  store: TreasuryStore;
  logger: Logger;
  /** 订阅账号登录 / 退出后,重新同步模型清单。 */
  onSubscriptionChanged: () => void;
  /** 端口绑定成功:只有抢到端口的那个 Host 才启动手机连接、登记 MCP、同步订阅模型。 */
  onListening: () => void;
  /** 端口被别的窗口的 Host 占着。 */
  onPortBusy: () => void;
}): Server {
  const key = leoLocalKey();
  // 钥匙比对用常数时间:先各自哈希成等长,再 timingSafeEqual,长度差也不泄露。
  const expected = createHash("sha256").update(`Bearer ${key}`).digest();
  const authorized = (header: string | undefined): boolean =>
    timingSafeEqual(createHash("sha256").update(header ?? "").digest(), expected);

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 64_000_000) req.destroy();
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
      // 防 DNS 重绑定:只认发给 127.0.0.1 / localhost 本端口的请求。
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${LEO_HTTP_PORT}` && host !== `localhost:${LEO_HTTP_PORT}`) {
        json(res, 421, { error: "misdirected request" });
        return;
      }

      // 订阅登录页:系统浏览器里打开。页面本身不含任何凭据。
      if (url.pathname === "/leo/oauth" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
        });
        res.end(OAUTH_PAGE_HTML);
        return;
      }

      // 登录页的接口:必须带 X-Leo-UI 头。跨站请求带自定义头会触发预检,我们不放行,
      // 所以别的网站没法替你发起登录或退出。
      if (url.pathname.startsWith("/api/leo/ui/oauth/")) {
        if (req.headers["x-leo-ui"] !== "1") {
          json(res, 403, { error: "forbidden" });
          return;
        }
        const sub = url.pathname.slice("/api/leo/ui/oauth".length);
        try {
          if (sub === "/providers" && req.method === "GET") {
            json(res, 200, { providers: await listOAuthProviders() });
            return;
          }
          const login = /^\/providers\/([^/]+)\/login$/.exec(sub);
          if (login && req.method === "POST") {
            const flowId = await startOAuthLogin(decodeURIComponent(login[1]!), deps.onSubscriptionChanged);
            json(res, 202, { flowId });
            return;
          }
          const logout = /^\/providers\/([^/]+)\/logout$/.exec(sub);
          if (logout && req.method === "POST") {
            await logoutOAuth(decodeURIComponent(logout[1]!));
            deps.onSubscriptionChanged();
            json(res, 200, { ok: true });
            return;
          }
          const flow = /^\/flows\/([^/]+)(\/answer|\/cancel)?$/.exec(sub);
          if (flow && req.method === "GET" && !flow[2]) {
            const state = getOAuthFlow(flow[1]!);
            json(res, state ? 200 : 404, state ?? { error: "no such flow" });
            return;
          }
          if (flow && req.method === "POST" && flow[2] === "/answer") {
            const body = await readBody(req);
            json(res, answerOAuthFlow(flow[1]!, String(body["value"] ?? "")) ? 200 : 409, { ok: true });
            return;
          }
          if (flow && req.method === "POST" && flow[2] === "/cancel") {
            json(res, cancelOAuthFlow(flow[1]!) ? 200 : 404, { ok: true });
            return;
          }
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
        json(res, 404, { error: "not found" });
        return;
      }

      if (url.pathname === "/api/leo/health") {
        json(res, 200, { ok: true, treasuryItems: deps.store.count() });
        return;
      }
      if (!authorized(req.headers.authorization)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      // OpenAI 兼容的模型代理(给 LeoPhoneAgent 自己的 Agent 用,Bearer 就是本机 key)。
      if (url.pathname === "/v1/models" && req.method === "GET") {
        await handleModelsRequest(res);
        return;
      }
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        await handleChatCompletions(req, res, await readBody(req));
        return;
      }
      // 「连接手机」面板(经主进程转过来,带本机 Bearer):连接状态 + 给新手机出一次性配对码。
      if (url.pathname === "/api/leo/link/status" && req.method === "GET") {
        json(res, 200, leoLinkStatus());
        return;
      }
      if (url.pathname === "/api/leo/link/pair" && req.method === "POST") {
        try {
          json(res, 200, await createLeoPairingCode());
        } catch (error) {
          deps.logger.warn("[leo/link] pairing code failed", { error: String(error) });
          json(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
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
      json(res, 404, { error: "not found" });
    })();
  });

  server.listen(LEO_HTTP_PORT, "127.0.0.1", () => {
    deps.logger.info(`[leo] local api on 127.0.0.1:${LEO_HTTP_PORT}`);
    deps.onListening();
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    // 每个窗口一个 Host;端口被别的窗口占着是正常情况,不能把 Host 带崩。
    if (error.code === "EADDRINUSE") {
      deps.onPortBusy();
      return;
    }
    deps.logger.warn("[leo] local api failed to listen", { error: String(error) });
  });
  return server;
}
