import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { LEO_HTTP_PORT, leoLocalKey, leoPairSecret, leoTreasuryKey, leoUiSecret } from "./leoPaths.js";
import {
  configureLeoDirect,
  createLeoDirectPairingCode,
  revokeLeoDirectDevice,
  createLeoPairingCode,
  forwardLeoagentEvent,
  leoLinkStatus,
  revokeLeoPairingCode,
} from "./link/index.js";
import { handleChatCompletions, handleModelsRequest } from "./modelProxy.js";
import { OAUTH_PAGE_HTML } from "./oauthPage.js";
import {
  answerOAuthFlow,
  cancelOAuthFlow,
  getOAuthFlow,
  listOAuthFlows,
  listOAuthProviders,
  logoutOAuth,
  OAuthRequestError,
  startOAuthLogin,
} from "./oauthRuntime.js";
import { executeTreasuryTool, TREASURY_TOOLS } from "./treasuryTools.js";
import type { TreasuryStore } from "./treasuryStore.js";

type Logger = {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
};

/** 订阅代理的长上下文也远到不了这个量;超了直接 413,不给本机进程拿大包拖垮 Host 的机会。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * 订阅代理的请求体会带着整段对话里的截图(base64),8MB 不够:以前超了回 413,Agent 当成普通请求错误,
 * 这个会话从此每一步都失败。放宽到 48MB;再大就按「上下文超窗」回,Agent 会先压缩再重试。
 */
const MAX_CHAT_BODY_BYTES = 48 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 常数时间比对:先各自哈希成等长,再 timingSafeEqual,长度差也不泄露。 */
function secretMatcher(secret: string): (candidate: string | undefined) => boolean {
  const expected = createHash("sha256").update(secret).digest();
  return (candidate) =>
    secret.length > 0 &&
    timingSafeEqual(
      createHash("sha256")
        .update(candidate ?? "")
        .digest(),
      expected,
    );
}

/** 路径里的 id:`%` 转义写坏了回 400,不要变成 500 和一条告警。 */
function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "bad path parameter");
  }
}

/** 按 Buffer 收齐再一次性解码:逐块 `raw += chunk` 会把跨块的多字节中文切成 U+FFFD。 */
export function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, "request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("aborted", () => fail(new HttpError(400, "request aborted")));
    req.on("error", (error) => fail(error));
  });
}

/**
 * [leo] 本机接口。只监听 127.0.0.1。三把钥匙,各管一段:
 * - 主钥匙 `~/.leoagent/key`:订阅模型代理、连接状态、藏宝阁(桌面设置页、本机 Agent 用);
 * - 藏宝阁钥匙 `~/.leoagent/treasury.key`:只能调藏宝阁,写进 `~/.agents/mcp.json` 的是它;
 * - 出配对码口令:只在主进程与 Host 的内存里,每次启动都换。
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
  const isMainKey = secretMatcher(`Bearer ${leoLocalKey()}`);
  const isTreasuryKey = secretMatcher(`Bearer ${leoTreasuryKey()}`);
  const isPairSecret = secretMatcher(leoPairSecret());
  // 口令为空(不是主进程拉起的 Host)时 secretMatcher 一律不认:登录页接口整体关闭。
  const isUiSecret = secretMatcher(leoUiSecret());

  const json = (res: ServerResponse, status: number, payload: unknown): void => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 防 DNS 重绑定:只认发给 127.0.0.1 / localhost 本端口的请求。
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${LEO_HTTP_PORT}` && host !== `localhost:${LEO_HTTP_PORT}`) {
      json(res, 421, { error: "misdirected request" });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      json(res, 400, { error: "bad request" });
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

    // 登录页的接口:X-Leo-UI 必须是本次启动的口令(只经应用打开的登录页 URL 片段带过来)。
    // 自定义头还让跨站请求先发预检、被我们拒掉;口令再挡住本机别的进程。
    if (url.pathname.startsWith("/api/leo/ui/oauth/")) {
      const presented = req.headers["x-leo-ui"];
      if (typeof presented !== "string" || !isUiSecret(presented)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      const sub = url.pathname.slice("/api/leo/ui/oauth".length);
      if (sub === "/providers" && req.method === "GET") {
        json(res, 200, { providers: await listOAuthProviders() });
        return;
      }
      if (sub === "/flows" && req.method === "GET") {
        json(res, 200, { flows: listOAuthFlows() });
        return;
      }
      const login = /^\/providers\/([^/]+)\/login$/.exec(sub);
      if (login && req.method === "POST") {
        const body = await readJsonBody(req);
        const flowId = await startOAuthLogin(decodeParam(login[1]!), deps.onSubscriptionChanged, {
          importFromOpenCodeCli: body["importFromOpenCodeCli"] === true,
        });
        json(res, 202, { flowId });
        return;
      }
      const logout = /^\/providers\/([^/]+)\/logout$/.exec(sub);
      if (logout && req.method === "POST") {
        await logoutOAuth(decodeParam(logout[1]!));
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
        const body = await readJsonBody(req);
        const ok = answerOAuthFlow(flow[1]!, String(body["value"] ?? ""));
        json(
          res,
          ok ? 200 : 409,
          ok ? { ok: true } : { ok: false, error: "flow is not waiting for input" },
        );
        return;
      }
      if (flow && req.method === "POST" && flow[2] === "/cancel") {
        const ok = cancelOAuthFlow(flow[1]!);
        json(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: "no such flow" });
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }

    if (url.pathname === "/api/leo/health") {
      let treasuryItems: number | null = null;
      try {
        treasuryItems = deps.store.count();
      } catch {
        treasuryItems = null;
      }
      // app 字段让别的程序(比如保留的 2.x)占着端口时,界面能认出来不是我们。
      json(res, 200, { ok: true, app: "leophoneagent-1.x", treasuryItems });
      return;
    }

    const authorization = req.headers.authorization;
    if (url.pathname === "/api/leo/link/leoagent-event" && req.method === "POST") {
      const body = await readJsonBody(req, 256 * 1024);
      const status = forwardLeoagentEvent(authorization, body.event);
      json(
        res,
        status,
        status === 200 ? { ok: true } : { error: status === 503 ? "link not running" : "rejected" },
      );
      return;
    }
    const treasuryPath = url.pathname.startsWith("/api/leo/treasury/");
    if (!isMainKey(authorization) && !(treasuryPath && isTreasuryKey(authorization))) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/api/leo/treasury/tools" && req.method === "GET") {
      json(res, 200, { tools: TREASURY_TOOLS });
      return;
    }
    if (url.pathname.startsWith("/api/leo/treasury/call/") && req.method === "POST") {
      const name = url.pathname.slice("/api/leo/treasury/call/".length);
      if (!TREASURY_TOOLS.some((tool) => tool.name === name)) {
        json(res, 404, { error: `unknown tool: ${name}` });
        return;
      }
      const body = await readJsonBody(req);
      try {
        json(res, 200, executeTreasuryTool(deps.store, name, body));
      } catch (error) {
        json(res, 400, { error: String(error) });
      }
      return;
    }

    // OpenAI 兼容的模型代理(给 LeoPhoneAgent 自己的 Agent 用,Bearer 就是本机 key)。
    if (url.pathname === "/v1/models" && req.method === "GET") {
      await handleModelsRequest(res);
      return;
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req, MAX_CHAT_BODY_BYTES);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 413) throw error;
        json(res, 400, {
          error: {
            message: "请求太大（对话里的图片或文件太多）",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        });
        return;
      }
      await handleChatCompletions(req, res, body);
      return;
    }
    if (url.pathname === "/api/leo/link/status" && req.method === "GET") {
      json(res, 200, leoLinkStatus());
      return;
    }
    if (url.pathname.startsWith("/api/leo/link/direct/") && req.method === "POST") {
      if (!isPairSecret(req.headers["x-leo-pair"] as string | undefined)) {
        json(res, 403, { error: "直连授权只能在 LeoBot 界面上操作" });
        return;
      }
      try {
        if (url.pathname === "/api/leo/link/direct/pair")
          json(res, 200, { ...createLeoDirectPairingCode(), machine: leoLinkStatus().machine });
        else if (url.pathname === "/api/leo/link/direct/configure") {
          await configureLeoDirect(await readJsonBody(req, 4096));
          json(res, 200, { ok: true });
        } else if (url.pathname === "/api/leo/link/direct/revoke") {
          const body = await readJsonBody(req, 4096);
          if (typeof body["deviceId"] !== "string") {
            json(res, 400, { error: "deviceId is required" });
            return;
          }
          await revokeLeoDirectDevice(body["deviceId"]);
          json(res, 200, { ok: true });
        } else json(res, 404, { error: "not found" });
      } catch (cause) {
        json(res, 400, { error: cause instanceof Error ? cause.message : "直连操作失败" });
      }
      return;
    }
    // 出码 / 作废码:除了主钥匙,还要主进程内存里的口令 —— 只有界面上点了才会经 IPC 带上。
    if (
      url.pathname === "/api/leo/link/pair" &&
      (req.method === "POST" || req.method === "DELETE")
    ) {
      if (!isPairSecret(req.headers["x-leo-pair"] as string | undefined)) {
        json(res, 403, { error: "配对码只能在 LeoBot 界面上生成" });
        return;
      }
      try {
        if (req.method === "POST") {
          json(res, 200, await createLeoPairingCode());
        } else {
          const token = url.searchParams.get("payload") ?? "";
          await revokeLeoPairingCode(token);
          json(res, 200, { ok: true });
        }
      } catch (error) {
        deps.logger.warn("[leo/link] pairing request failed", { error: String(error) });
        json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    json(res, 404, { error: "not found" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status =
        error instanceof HttpError ? error.status : error instanceof OAuthRequestError ? 400 : 500;
      if (status === 500)
        deps.logger.warn("[leo] local api request failed", { error: String(error) });
      json(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
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
