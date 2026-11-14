import { randomUUID } from "node:crypto";
import { ipcMain, type Protocol } from "electron";
import {
  buildHtmlArtifactCsp,
  htmlArtifactPreviewRequestSchema,
  PlatformChannels,
  type HtmlArtifactPreviewHandle,
} from "@zcode/shared";
import { isTrustedAppSender } from "./trustedAppSender.js";

export const HTML_ARTIFACT_PREVIEW_CSP = buildHtmlArtifactCsp;
export const HTML_ARTIFACT_SCHEME = "leo-html";
export const HTML_ARTIFACT_PRIVILEGED_SCHEME = {
  scheme: HTML_ARTIFACT_SCHEME,
  privileges: { standard: true, secure: true },
};
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEWS = 32;

interface PreviewRecord {
  id: string;
  owner: number;
  html: string;
  interactive: boolean;
  expiresAt: number;
}
/** 原生视图内容的有界所有者；不接收任务状态，不访问文件或模型。 */
export function createHtmlPreviewRegistry(
  options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
) {
  const records = new Map<string, PreviewRecord>();
  const now = options.now ?? Date.now;
  const prune = () => {
    for (const [id, record] of records) if (record.expiresAt <= now()) records.delete(id);
  };
  return {
    create(owner: number, input: unknown): HtmlArtifactPreviewHandle {
      const request = htmlArtifactPreviewRequestSchema.parse(input);
      prune();
      if (records.size >= (options.maxEntries ?? MAX_PREVIEWS))
        throw new Error("HTML preview capacity reached. Close another preview and retry.");
      const id = randomUUID();
      records.set(id, {
        id,
        owner,
        ...request,
        expiresAt: now() + (options.ttlMs ?? DEFAULT_TTL_MS),
      });
      return { id, url: `${HTML_ARTIFACT_SCHEME}://preview-${id}/` };
    },
    get(id: string): PreviewRecord | null {
      prune();
      return records.get(id) ?? null;
    },
    release(owner: number, id: string): boolean {
      if (records.get(id)?.owner !== owner) return false;
      return records.delete(id);
    },
    releaseOwner(owner: number): void {
      for (const [id, record] of records) if (record.owner === owner) records.delete(id);
    },
  };
}

const registry = createHtmlPreviewRegistry();
const watchedOwners = new WeakSet<object>();

export function registerHtmlArtifactPreviewIpc(): void {
  ipcMain.handle(PlatformChannels.CreateHtmlPreview, (event, input: unknown) => {
    if (!isTrustedAppSender(event)) throw new Error("untrusted_sender");
    if (!watchedOwners.has(event.sender)) {
      watchedOwners.add(event.sender);
      const ownerId = event.sender.id;
      const releaseOwner = () => registry.releaseOwner(ownerId);
      event.sender.once("destroyed", releaseOwner);
      event.sender.on("did-navigate", releaseOwner);
      event.sender.on("render-process-gone", releaseOwner);
    }
    return registry.create(event.sender.id, input);
  });
  ipcMain.handle(PlatformChannels.ReleaseHtmlPreview, (event, id: unknown) => {
    if (!isTrustedAppSender(event) || typeof id !== "string") return;
    registry.release(event.sender.id, id);
  });
}

export function installHtmlArtifactPreviewProtocol(protocol: Pick<Protocol, "handle">): void {
  protocol.handle(HTML_ARTIFACT_SCHEME, (request) => {
    const url = new URL(request.url);
    const id = url.hostname.startsWith("preview-") ? url.hostname.slice("preview-".length) : "";
    const record = url.pathname === "/" && !url.search ? registry.get(id) : null;
    if (!record) return new Response("Preview unavailable", { status: 404 });
    return new Response(record.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": buildHtmlArtifactCsp(record.interactive),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy":
          "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
      },
    });
  });
}
