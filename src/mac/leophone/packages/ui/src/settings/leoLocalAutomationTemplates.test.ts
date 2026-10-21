import { isValidCronExpr } from "@zcode/services";
import { describe, expect, it } from "vitest";
import { canVisualizeCronInAutomationEditor } from "@/settings/automationFormat.js";
import {
  LEO_LOCAL_SCHEDULED_TEMPLATES,
  materializeScheduledTemplateDraft,
} from "@/settings/automationTemplateCatalog.js";

describe("LEO_LOCAL_SCHEDULED_TEMPLATES", () => {
  it("only ships schedules the editor can show and edit", () => {
    expect(LEO_LOCAL_SCHEDULED_TEMPLATES).toHaveLength(3);
    for (const template of LEO_LOCAL_SCHEDULED_TEMPLATES) {
      expect(isValidCronExpr(template.cronExpr)).toBe(true);
      expect(canVisualizeCronInAutomationEditor(template.cronExpr)).toBe(true);
    }
  });

  it("prefills a Chinese draft with title and prompt", () => {
    const draft = materializeScheduledTemplateDraft(LEO_LOCAL_SCHEDULED_TEMPLATES[0]!, "zh-CN");
    expect(draft.title).toBe("每日早报");
    expect(draft.prompt.length).toBeGreaterThan(20);
    expect(draft.cronExpr).toBe("0 9 * * *");
  });
});
