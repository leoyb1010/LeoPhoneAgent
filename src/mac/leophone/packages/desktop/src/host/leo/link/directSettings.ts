import { promises as fs } from "node:fs";
import { leoPath } from "../leoPaths.js";
import { writeDurableJson } from "./durableJson.js";

export function directConfig(value: unknown): {
  enabled: boolean;
  port: number;
  baseURL: string;
  syncEnabled: boolean;
  treasuryEnabled: boolean;
} | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw["enabled"] !== true) return null;
  const url = new URL(String(raw["baseURL"] ?? ""));
  const port = Number(raw["port"] ?? 38474);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".ts.net") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error("Direct requires an HTTPS Tailscale hostname and a dedicated loopback port");
  return {
    enabled: true,
    port,
    baseURL: url.origin,
    syncEnabled: raw["syncEnabled"] === true,
    treasuryEnabled: raw["treasuryEnabled"] === true,
  };
}

let configuring: Promise<unknown> = Promise.resolve();
export function configureLeoDirect(value: unknown): Promise<void> {
  const next = configuring.then(async () => {
    const direct = directConfig(value);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(leoPath("link.json"), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await writeDurableJson(leoPath("link.json"), {
      ...existing,
      ...(direct ? { enabled: true } : {}),
      direct: direct ?? { ...(existing["direct"] && typeof existing["direct"] === "object" ? existing["direct"] : {}), enabled: false },
    });
  });
  configuring = next.catch(() => undefined);
  return next;
}
