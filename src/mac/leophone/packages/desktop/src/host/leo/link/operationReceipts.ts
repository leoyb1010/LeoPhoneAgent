import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LinkRequest, LinkResponse } from "./bridge.js";
import { writeDurableJson } from "./durableJson.js";

type Receipt = {
  version: 1;
  fingerprint: string;
  state: "admitted" | "completed";
  response?: LinkResponse;
  checkpoint?: Record<string, unknown>;
};
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uncertain = (): LinkResponse => ({
  status: 409,
  body: {
    error: {
      code: "operation_uncertain",
      message: "Mac 已接收操作，但尚无可恢复回执。请核对任务状态，不要重新创建操作。",
    },
  },
});

/** 传输回执，不保存另一套业务任务/队列。意图写入后绝不因 HTTP 5xx 自动重复副作用。 */
export class OperationReceipts {
  private active = new Map<string, { fingerprint: string; response: Promise<LinkResponse> }>();
  constructor(private readonly directory: string) {}
  operationId(req: LinkRequest, phase: string): string {
    return `leo-${this.key(req)}-${phase}`;
  }
  private key(req: LinkRequest): string {
    return hash(`${req.caller.kind}:${req.caller.deviceId ?? "legacy"}:${req.requestId}`);
  }
  private file(key: string): string {
    return path.join(this.directory, `${key}.json`);
  }
  private async read(key: string): Promise<Receipt | null> {
    try {
      const receipt = JSON.parse(await readFile(this.file(key), "utf8")) as Receipt;
      if (
        receipt.version !== 1 ||
        !["admitted", "completed"].includes(receipt.state) ||
        typeof receipt.fingerprint !== "string" ||
        (receipt.state === "completed" &&
          (!receipt.response || !Number.isInteger(receipt.response.status)))
      )
        throw new Error("Invalid operation receipt");
      return receipt;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  }
  async status(req: LinkRequest): Promise<LinkResponse> {
    const receipt = await this.read(this.key(req));
    return receipt
      ? {
          status: 200,
          body: {
            requestId: req.requestId,
            state: receipt.state === "completed" ? "completed" : "uncertain",
            response: receipt.response,
            ...(typeof receipt.checkpoint?.["taskId"] === "string" ? { taskId: receipt.checkpoint["taskId"] } : {}),
          },
        }
      : { status: 404, body: { error: { code: "operation_not_found" } } };
  }
  async checkpoint(req: LinkRequest, value: Record<string, unknown>): Promise<void> {
    const key = this.key(req);
    const receipt = await this.read(key);
    if (!receipt || receipt.state !== "admitted") throw new Error("Operation admission missing");
    await writeDurableJson(this.file(key), { ...receipt, checkpoint: value });
  }
  run(
    req: LinkRequest,
    execute: () => Promise<LinkResponse>,
    recover?: (checkpoint: Record<string, unknown>) => Promise<LinkResponse | null>,
  ): Promise<LinkResponse> {
    const key = this.key(req);
    const fingerprint = hash(
      canonical({ method: req.method.toUpperCase(), path: req.path, body: req.body }),
    );
    const conflict = (): LinkResponse => ({
      status: 409,
      body: { error: { code: "request_id_conflict", message: "同一操作编号不能用于不同内容" } },
    });
    const active = this.active.get(key);
    if (active)
      return active.fingerprint === fingerprint ? active.response : Promise.resolve(conflict());
    const response = (async () => {
      const existing = await this.read(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return conflict();
        if (existing.response) return existing.response;
        const recovered =
          existing.checkpoint && recover ? await recover(existing.checkpoint) : null;
        if (!recovered) return uncertain();
        await writeDurableJson(this.file(key), {
          ...existing,
          state: "completed",
          response: recovered,
        });
        return recovered;
      }
      await writeDurableJson(this.file(key), {
        version: 1,
        fingerprint,
        state: "admitted",
      } satisfies Receipt);
      let result: LinkResponse;
      try {
        result = await execute();
      } catch {
        return uncertain();
      }
      await writeDurableJson(this.file(key), {
        version: 1,
        fingerprint,
        state: "completed",
        response: result,
      } satisfies Receipt);
      return result;
    })();
    this.active.set(key, { fingerprint, response });
    void response.finally(() => this.active.delete(key)).catch(() => undefined);
    return response;
  }
}
