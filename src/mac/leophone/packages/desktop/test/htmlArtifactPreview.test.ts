import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../src/main/trustedAppSender.js", () => ({ isTrustedAppSender: () => true }));
import {
  createHtmlPreviewRegistry,
  HTML_ARTIFACT_PREVIEW_CSP,
} from "../src/main/htmlArtifactPreview.js";

describe("native HTML artifact preview", () => {
  it("returns opaque URLs, isolates document policy and releases only the owning window", () => {
    const registry = createHtmlPreviewRegistry();
    const handle = registry.create(7, {
      html: '<button onclick="this.textContent=42">run</button>',
      interactive: true,
    });
    expect(handle.url).toMatch(/^leo-html:\/\/preview-[a-f0-9-]+\/$/);
    expect(handle.url).not.toContain("button");
    expect(registry.get(handle.id)?.html).toContain("onclick");
    expect(registry.release(8, handle.id)).toBe(false);
    expect(registry.release(7, handle.id)).toBe(true);
    expect(registry.get(handle.id)).toBeNull();
    expect(HTML_ARTIFACT_PREVIEW_CSP(false)).toContain("script-src 'none'");
    expect(HTML_ARTIFACT_PREVIEW_CSP(true)).toContain("connect-src 'none'");
  });
  it("rejects malformed/oversized content and enforces bounded capacity without evicting active views", () => {
    const registry = createHtmlPreviewRegistry({ maxEntries: 1 });
    expect(() =>
      registry.create(1, { html: "x", interactive: true, token: "unexpected" }),
    ).toThrow();
    expect(() =>
      registry.create(1, { html: "x".repeat(1024 * 1024 + 1), interactive: false }),
    ).toThrow();
    const first = registry.create(1, { html: "<p>first</p>", interactive: false });
    expect(() => registry.create(2, { html: "<p>second</p>", interactive: false })).toThrow();
    expect(registry.get(first.id)?.html).toBe("<p>first</p>");
  });
  it("expires views and cleans up all records when the owning window closes", () => {
    let now = 0;
    const registry = createHtmlPreviewRegistry({ now: () => now, ttlMs: 100 });
    const first = registry.create(1, { html: "first", interactive: false });
    const second = registry.create(2, { html: "second", interactive: false });
    registry.releaseOwner(1);
    expect(registry.get(first.id)).toBeNull();
    expect(registry.get(second.id)?.html).toBe("second");
    now = 101;
    expect(registry.get(second.id)).toBeNull();
  });
});
