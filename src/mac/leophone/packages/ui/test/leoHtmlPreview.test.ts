import { describe, expect, it } from "vitest";
import {
  buildLeoHtmlPreviewDocument,
  canPreviewLeoHtmlFile,
  isLeoHtmlPath,
  LEO_HTML_PREVIEW_LIMIT,
} from "@/leo/htmlArtifactPolicy.js";

describe("HTML artifact preview admission", () => {
  it("recognizes HTML files without treating similarly named scripts as HTML", () => {
    expect(isLeoHtmlPath("/workspace/Report.HTML")).toBe(true);
    expect(isLeoHtmlPath("/workspace/index.htm")).toBe(true);
    expect(isLeoHtmlPath("/workspace/index.html.js")).toBe(false);
  });
  it("only executes a complete non-binary bounded file, never a text slice", () => {
    const full = {
      content: "<h1>你好</h1>",
      offset: 0,
      bytesRead: 17,
      totalBytes: 17,
      truncated: false,
      isBinary: false,
    };
    expect(canPreviewLeoHtmlFile(full)).toBe(true);
    expect(canPreviewLeoHtmlFile({ ...full, offset: 1 })).toBe(false);
    expect(canPreviewLeoHtmlFile({ ...full, truncated: true })).toBe(false);
    expect(canPreviewLeoHtmlFile({ ...full, totalBytes: 100 })).toBe(false);
    expect(canPreviewLeoHtmlFile({ ...full, isBinary: true })).toBe(false);
    expect(
      canPreviewLeoHtmlFile({ ...full, content: "a".repeat(LEO_HTML_PREVIEW_LIMIT + 1) }),
    ).toBe(false);
  });
  it("puts restrictive policy before authored HTML so inline content cannot relax it", () => {
    const input =
      '<!doctype html><script>document.body.textContent="ok"</script><img src="https://example.com/pixel">';
    expect(buildLeoHtmlPreviewDocument(input)).toContain("script-src 'none'");
    const result = buildLeoHtmlPreviewDocument(input, true);
    expect(result.indexOf("Content-Security-Policy")).toBeLessThan(result.indexOf("<script>"));
    expect(result).toContain("connect-src 'none'");
    expect(result).toContain("form-action 'none'");
    expect(result).toContain("frame-src 'none'");
    expect(result).toContain("script-src 'unsafe-inline'");
    expect(result).toContain(input);
  });
});
