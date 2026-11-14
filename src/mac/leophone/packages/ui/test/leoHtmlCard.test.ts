import { describe, expect, it } from "vitest";
import { shouldRenderAssistantPreviewCardAsFile } from "@/AssistantPreviewCards.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
const card = {
  id: "html:/workspace/report.html",
  type: "website",
  title: "report.html",
  url: "file:///workspace/report.html",
  filePath: "/workspace/report.html",
  subtitleId: "chat.previewCards.htmlWebsite",
} satisfies AssistantPreviewCard;
describe("HTML artifact entry", () => {
  it("opens local generated HTML in the artifact preview, while live URLs keep the browser route", () => {
    expect(shouldRenderAssistantPreviewCardAsFile(card, {})).toBe(true);
    expect(
      shouldRenderAssistantPreviewCardAsFile({ ...card, url: "http://localhost:5173/" }, {}),
    ).toBe(false);
  });
});
