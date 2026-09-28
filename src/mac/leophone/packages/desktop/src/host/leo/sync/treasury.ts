import type { TreasuryStore } from "../treasuryStore.js";
import { executeTreasuryTool, TREASURY_TOOLS } from "../treasuryTools.js";
import { json, readBody } from "./http.js";
import type { ReplicaHandler } from "./http.js";
import { check, ReplicaError } from "./wire.js";
/** Same Treasury owner and tools as loopback API; caller enforces treasury grant scope. */
export function createTreasuryHandler(store: TreasuryStore): ReplicaHandler {
  return async (req, res, principal) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/treasury/v1/")) return false;
    try {
      check(principal.deviceId, "authenticated device required", 401);
      if (path === "/treasury/v1/tools" && req.method === "GET") {
        json(res, 200, { tools: TREASURY_TOOLS });
        return true;
      }
      check(req.method === "POST", "method not allowed", 405);
      const name = path.slice("/treasury/v1/call/".length);
      check(
        path.startsWith("/treasury/v1/call/") && TREASURY_TOOLS.some((tool) => tool.name === name),
        "tool not found",
        404,
      );
      // Writes reuse existing explicit user_confirmed gate and exactly one store.
      // They are not automatically retried across paths: existing save creates a new ID.
      let value: unknown;
      try {
        value = JSON.parse((await readBody(req, 1024 * 1024)).toString());
      } catch (error) {
        if (error instanceof ReplicaError) throw error;
        throw new ReplicaError(400, "invalid JSON");
      }
      check(value && typeof value === "object" && !Array.isArray(value), "invalid tool input");
      json(res, 200, executeTreasuryTool(store, name, value as Record<string, unknown>));
    } catch (error) {
      if (!res.headersSent)
        json(res, error instanceof ReplicaError ? error.status : 500, {
          error: error instanceof ReplicaError ? error.message : "treasury operation failed",
        });
      else res.destroy();
    }
    return true;
  };
}
