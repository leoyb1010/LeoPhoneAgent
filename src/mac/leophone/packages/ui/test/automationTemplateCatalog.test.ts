import { describe, expect, it } from "vitest";
import type { ClientSceneConfig } from "@zcode/services";
import {
  LEO_LOCAL_SCHEDULED_TEMPLATES,
  materializeScheduledTemplateDraft,
  mapClientScenesToAutomationTemplates,
  resolveAutomationTemplateText,
} from "@/settings/automationTemplateCatalog.js";

function createScenes(cronExpr = "0 9 * * 1-5"): ClientSceneConfig[] {
  return [
    {
      namespace: "zcode",
      scene: "scheduled-task",
      options: {
        prompts: {
          id: "scheduled-prompts",
          type: "prompts",
          contents: { cn: "定时任务模板", en: "Scheduled task template" },
          items: [
            {
              id: "item-morningDevBrief",
              type: "prompts",
              contents: { cn: "中文定时指令", en: "English scheduled prompt" },
              labels: { cn: "晨会动态", en: "Morning dev brief" },
              on_finish: null,
              img: null,
              defaults: { cronExpr: ["item-morningDevBrief-cronExpr"] },
            },
          ],
          refer: "",
          templates: { cn: "{prompt}", en: "{prompt}" },
        },
        cronExpr: {
          id: "scheduled-cron",
          type: "cronExpr",
          contents: { cn: "调度规则", en: "Schedule" },
          items: [
            {
              id: "item-morningDevBrief-cronExpr",
              type: "cronExpr",
              contents: { cn: cronExpr, en: cronExpr },
              // 服务端 label 只作配置说明，外显必须由 contents 中的 cron 本地解析。
              labels: { cn: "错误的服务端外显", en: "Wrong server display" },
              on_finish: null,
              img: null,
            },
          ],
          refer: "",
          templates: { cn: "{prompt}", en: "{prompt}" },
        },
      },
      created_at: 0,
      updated_at: 0,
    },
    {
      namespace: "zcode",
      scene: "off-peak-task",
      options: {
        prompts: {
          id: "off-peak-prompts",
          type: "prompts",
          contents: { cn: "闲时任务模板", en: "Idle-time task template" },
          items: [
            {
              id: "item-ciFlakyReport",
              type: "prompts",
              contents: { cn: "中文闲时指令", en: "English idle prompt" },
              labels: { cn: "CI 报告", en: "CI report" },
              on_finish: null,
              img: null,
            },
          ],
          refer: "",
          templates: { cn: "{prompt}", en: "{prompt}" },
        },
      },
      created_at: 0,
      updated_at: 0,
    },
  ] as ClientSceneConfig[];
}

describe("Client Scenes automation template catalog", () => {
  it("maps scheduled-task defaults to cron contents and never keeps cron labels", () => {
    const result = mapClientScenesToAutomationTemplates(
      createScenes(),
      (cronExpr) => cronExpr === "0 9 * * 1-5",
    );

    expect(result.scheduled).toEqual([
      expect.objectContaining({
        id: "item-morningDevBrief",
        title: { cn: "晨会动态", en: "Morning dev brief" },
        prompt: { cn: "中文定时指令", en: "English scheduled prompt" },
        cronExpr: "0 9 * * 1-5",
        icon: "target",
      }),
    ]);
    expect(JSON.stringify(result.scheduled)).not.toContain("错误的服务端外显");
    expect(JSON.stringify(result.scheduled)).not.toContain("Wrong server display");
  });

  it("keeps prompt item img as the Lucide icon name for the scheduled catalog", () => {
    const scenes = createScenes();
    scenes[0]!.options.prompts!.items![0]!.img = "  calendar-clock  ";
    scenes[0]!.options.prompts!.items![0]!.imgs = {
      cn: "https://cdn.example.com/scheduled-template-cn.svg",
    };

    const result = mapClientScenesToAutomationTemplates(scenes, () => true);

    expect(result.scheduled[0]).toEqual(
      expect.objectContaining({
        iconName: "calendar-clock",
        icon: "target",
      }),
    );
  });

  it("rejects a missing or invalid cron before the template can enter creation", () => {
    const invalid = mapClientScenesToAutomationTemplates(createScenes("invalid cron"), () => false);
    const missingReferenceScenes = createScenes();
    const scheduledPrompt = missingReferenceScenes[0]!.options.prompts!.items![0]!;
    scheduledPrompt.defaults = { cronExpr: ["missing-cron-item"] };
    const missing = mapClientScenesToAutomationTemplates(missingReferenceScenes, () => true);

    expect(invalid.scheduled).toEqual([]);
    expect(invalid.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
    expect(missing.scheduled).toEqual([]);
    expect(missing.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
  });

  it("rejects a service-valid cron that the Automation editor cannot round-trip", () => {
    const result = mapClientScenesToAutomationTemplates(createScenes("0 0 9 * * 1-5"), () => true);

    expect(result.scheduled).toEqual([]);
    expect(result.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
  });

  it("rejects scheduled templates whose localized titles are both blank", () => {
    const scenes = createScenes();
    scenes[0]!.options.prompts!.items![0]!.labels = { cn: " ", en: "" };

    const result = mapClientScenesToAutomationTemplates(scenes, () => true);

    expect(result.scheduled).toEqual([]);
    expect(result.rejectedScheduledTemplateIds).toEqual(["item-morningDevBrief"]);
  });

  // [leo] Off-peak (idle-time) tasks were removed: the off-peak-task scene is ignored and no idle catalog,
  // local Customize template or off-peak text helpers exist any more.
  it("ignores the off-peak-task scene and only builds the scheduled catalog", () => {
    const result = mapClientScenesToAutomationTemplates(createScenes(), () => true);

    expect(Object.keys(result).sort()).toEqual(["rejectedScheduledTemplateIds", "scheduled"]);
    expect(JSON.stringify(result)).not.toContain("item-ciFlakyReport");
  });

  it("materializes current-locale primitives that are independent from later catalog refreshes", () => {
    const first = mapClientScenesToAutomationTemplates(createScenes(), () => true);
    const scheduledDraft = materializeScheduledTemplateDraft(first.scheduled[0]!, "zh-CN");

    const refreshedScenes = createScenes();
    refreshedScenes[0]!.options.prompts!.items![0]!.labels.cn = "后台刷新标题";
    mapClientScenesToAutomationTemplates(refreshedScenes, () => true);

    expect(scheduledDraft).toEqual({
      templateId: "item-morningDevBrief",
      title: "晨会动态",
      cronExpr: "0 9 * * 1-5",
      prompt: "中文定时指令",
    });
  });

  // [leo] 本地模板的权限模式带进新建页:只读的早报是 plan,否则按默认 build 建出来,每次运行都要人批。
  it("carries the Leo template mode into the creation draft", () => {
    const [brief, tests] = LEO_LOCAL_SCHEDULED_TEMPLATES;
    expect(materializeScheduledTemplateDraft(brief!, "zh-CN").mode).toBe("plan");
    expect(materializeScheduledTemplateDraft(tests!, "en-US").mode).toBe("guarded");
  });

  it("resolves the active locale with a deterministic opposite-language fallback", () => {
    expect(resolveAutomationTemplateText({ cn: "中文", en: "English" }, "zh-CN")).toBe("中文");
    expect(resolveAutomationTemplateText({ en: "English" }, "zh-CN")).toBe("English");
    expect(resolveAutomationTemplateText({ cn: "中文" }, "en-US")).toBe("中文");
  });
});
