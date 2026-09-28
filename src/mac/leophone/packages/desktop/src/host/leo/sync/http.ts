import type { IncomingMessage, ServerResponse } from "node:http";
import { check, MAX_BATCH_BYTES, MAX_CHUNK, ReplicaError } from "./wire.js";
import type { SyncReplicaStore } from "./replica.js";
export interface ReplicaPrincipal {
  deviceId: string;
}
export type ReplicaHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  principal: ReplicaPrincipal,
) => Promise<boolean>;
export async function readBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value as Uint8Array);
    length += chunk.length;
    check(length <= maximum, "request too large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
export function createReplicaHandler(store: SyncReplicaStore): ReplicaHandler {
  return async (req, res, principal) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/sync/v1/")) return false;
    try {
      check(principal.deviceId, "authenticated sender required", 401);
      if (url.pathname === "/sync/v1/changes") {
        if (req.method === "GET")
          json(
            res,
            200,
            store.changes(
              Number(url.searchParams.get("after") ?? 0),
              Number(url.searchParams.get("limit") ?? 100),
            ),
          );
        else if (req.method === "POST") {
          let value: unknown;
          try {
            value = JSON.parse((await readBody(req, MAX_BATCH_BYTES)).toString());
          } catch (error) {
            if (error instanceof ReplicaError) throw error;
            throw new ReplicaError(400, "invalid JSON");
          }
          check(value && typeof value === "object" && "changes" in value, "missing changes");
          json(res, 200, {
            replicaId: store.replicaId,
            receipts: store.apply(principal.deviceId, value.changes),
          });
        } else throw new ReplicaError(405, "method not allowed");
      } else {
        const match = /^\/sync\/v1\/assets\/([a-f0-9]{64})$/.exec(url.pathname);
        check(match, "route not found", 404);
        const hash = match[1]!;
        if (req.method === "PUT") {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers["content-range"]));
          const empty = req.headers["content-range"] === "bytes */0";
          check(range || empty, "Content-Range required");
          const start = empty ? 0 : Number(range![1]);
          const end = empty ? -1 : Number(range![2]);
          const total = empty ? 0 : Number(range![3]);
          const bytes = await readBody(req, MAX_CHUNK);
          check(bytes.length === end - start + 1, "Content-Range length mismatch");
          json(
            res,
            200,
            store.putAsset(hash, start, total, bytes, req.headers["upload-reset"] === "true"),
          );
        } else if (req.method === "HEAD" || req.method === "GET") {
          const status = store.assetStatus(hash);
          check(status, "asset not found", 404);
          if (req.method === "HEAD") {
            res.writeHead(200, {
              "Upload-Offset": status.offset,
              "Upload-Length": status.size,
              "X-Asset-Complete": String(status.complete),
              "Cache-Control": "no-store",
            });
            res.end();
          } else {
            check(status.complete, "asset incomplete", 409);
            let start = 0;
            let end = status.size - 1;
            if (req.headers.range) {
              const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
              check(range && (range[1] || range[2]), "invalid byte range", 416);
              if (range[1]) {
                start = Number(range[1]);
                if (range[2]) end = Math.min(Number(range[2]), end);
              } else {
                const suffix = Number(range[2]);
                check(suffix > 0, "invalid suffix range", 416);
                start = Math.max(0, status.size - suffix);
              }
              check(status.size > 0 && start <= end, "range not satisfiable", 416);
            }
            res.writeHead(req.headers.range ? 206 : 200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": Math.max(0, end - start + 1),
              "Accept-Ranges": "bytes",
              ETag: `"${hash}"`,
              ...(req.headers.range
                ? { "Content-Range": `bytes ${start}-${end}/${status.size}` }
                : {}),
            });
            for (let offset = start; offset <= end; offset += MAX_CHUNK) {
              if (res.destroyed) break;
              const bytes = store.readAsset(hash, offset, Math.min(end, offset + MAX_CHUNK - 1));
              if (!res.write(bytes))
                await new Promise<void>((resolve) => {
                  const done = () => {
                    res.off("drain", done);
                    res.off("close", done);
                    resolve();
                  };
                  res.once("drain", done);
                  res.once("close", done);
                  if (res.destroyed) done();
                });
            }
            res.end();
          }
        } else throw new ReplicaError(405, "method not allowed");
      }
    } catch (error) {
      if (!res.headersSent)
        json(res, error instanceof ReplicaError ? error.status : 500, {
          error: error instanceof ReplicaError ? error.message : "replica storage failure",
        });
      else res.destroy();
    }
    return true;
  };
}
