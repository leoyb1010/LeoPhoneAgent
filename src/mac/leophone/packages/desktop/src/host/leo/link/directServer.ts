import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { LeoDeviceDescriptor } from "@zcode/shared/leo-device";
import type { LinkBridge, LinkRequest, LinkResponse } from "./bridge.js";
import type { DirectGrants } from "./directGrants.js";
import { isLinkPath, record } from "./linkPolicy.js";

function reply(res: ServerResponse, result: LinkResponse): void {
  res.writeHead(result.status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(result.body));
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new Error("body_limit");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

/** 专用 loopback 端口只承载手机协议。HTTPS 由用户已有/显式配置的 Tailscale Serve 提供。 */
export type ReplicaRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  principal: { deviceId: string },
) => Promise<boolean>;
export async function startDirectServer(args: {
  bridge: LinkBridge;
  grants: DirectGrants;
  device: LeoDeviceDescriptor;
  port: number;
  replicaHandler?: ReplicaRequestHandler;
  treasuryHandler?: ReplicaRequestHandler;
}): Promise<{ port: number; stop(): Promise<void> }> {
  const controllers = new Set<AbortController>();
  const server = http.createServer((req, res) => {
    void (async () => {
      // 浏览器跨源/DNS rebinding 不得借 localhost 发授权请求；原生客户端没有 Origin。
      if (req.headers.origin)
        return reply(res, { status: 403, body: { error: "origin_not_allowed" } });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/direct-pair" && req.method === "POST") {
        const body = record(await jsonBody(req));
        const grant = await args.grants.redeem(
          String(body.join ?? ""),
          String(body.targetDeviceId ?? ""),
          String(body.name ?? "Mobile"),
        );
        return reply(
          res,
          grant
            ? { status: 200, body: { device: args.device, grant } }
            : { status: 403, body: { error: "pairing_rejected" } },
        );
      }
      const authorization = req.headers.authorization ?? "";
      const target = req.headers["x-leo-device-id"];
      const caller = args.grants.authenticate(
        authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
        typeof target === "string" ? target : "",
      );
      if (!caller)
        return reply(res, { status: 401, body: { error: "direct_authorization_required" } });
      if (url.pathname.startsWith("/sync/v1/")) {
        if (!args.grants.hasScope(authorization.slice(7), String(target), "sync"))
          return reply(res, { status: 403, body: { error: "sync_scope_required" } });
        if (
          args.replicaHandler &&
          (await args.replicaHandler(req, res, { deviceId: caller.deviceId! }))
        )
          return;
        return reply(res, { status: 404, body: { error: "replica_not_configured" } });
      }
      if (url.pathname.startsWith("/treasury/v1/")) {
        if (!args.grants.hasScope(authorization.slice(7), String(target), "treasury"))
          return reply(res, { status: 403, body: { error: "treasury_scope_required" } });
        if (
          args.treasuryHandler &&
          (await args.treasuryHandler(req, res, { deviceId: caller.deviceId! }))
        )
          return;
        return reply(res, { status: 404, body: { error: "treasury_not_configured" } });
      }
      if (!args.grants.hasScope(authorization.slice(7), String(target), "harness"))
        return reply(res, { status: 403, body: { error: "harness_scope_required" } });
      // 不暴露 Grok token 或任何 /api 管理接口；能力列表不等于开放所有本机端口。
      if (
        (!isLinkPath(url.pathname) &&
          !/^\/operations\/[a-zA-Z0-9_.:-]{1,200}$/.test(url.pathname)) ||
        url.pathname === "/v1/grok/token"
      )
        return reply(res, { status: 404, body: { error: "not_found" } });
      const requestId = req.headers["x-request-id"];
      if (
        req.method === "POST" &&
        (typeof requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(requestId))
      )
        return reply(res, { status: 400, body: { error: "request_id_required" } });
      const request: LinkRequest = {
        method: req.method ?? "GET",
        path: url.pathname + url.search,
        caller,
        transport: "direct",
        requestId: typeof requestId === "string" ? requestId : undefined,
        body: req.method === "POST" ? await jsonBody(req) : undefined,
      };
      if (req.method === "GET" && /^\/harness\/sessions\/[^/]+\/events$/.test(url.pathname)) {
        const controller = new AbortController();
        controllers.add(controller);
        res.on("close", () => controller.abort());
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        // 长连接不能沿用入口的认证快照；每次写出前同时检查撤销和 token 到期。
        const writeAuthorized = (data: string) => {
          if (controller.signal.aborted) return;
          if (!args.grants.hasScope(authorization.slice(7), String(target), "harness")) {
            controller.abort();
            return;
          }
          res.write(data);
        };
        const heartbeat = setInterval(() => writeAuthorized(": keepalive\n\n"), 5_000);
        try {
          await args.bridge.stream(
            request,
            (data) => writeAuthorized(`data: ${data}\n\n`),
            controller.signal,
          );
        } finally {
          clearInterval(heartbeat);
          controllers.delete(controller);
          res.end();
        }
        return;
      }
      reply(res, await args.bridge.handle(request));
    })().catch((cause: unknown) => {
      if (!res.headersSent)
        reply(res, {
          status: cause instanceof SyntaxError ? 400 : 503,
          body: { error: "direct_request_failed" },
        });
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    async stop() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      );
    },
  };
}
