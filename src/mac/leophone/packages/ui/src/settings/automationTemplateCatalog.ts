import type { ClientSceneConfig, ClientSceneItem } from "@zcode/services";
import type { AutomationScheduledTemplateIconName } from "@/settings/AutomationScheduledTemplateIcon.js";
import { canVisualizeCronInAutomationEditor } from "@/settings/automationFormat.js";

export interface AutomationTemplateLocalizedText {
  cn?: string;
  en?: string;
}

interface AutomationTemplateBase {
  id: string;
  iconName?: string;
  title: AutomationTemplateLocalizedText;
  description: AutomationTemplateLocalizedText;
  prompt: AutomationTemplateLocalizedText;
}

export interface ScheduledAutomationTemplate extends AutomationTemplateBase {
  cronExpr: string;
  icon: AutomationScheduledTemplateIconName;
}

export interface AutomationTemplateCatalog {
  scheduled: ScheduledAutomationTemplate[];
  rejectedScheduledTemplateIds: string[];
}

function normalizeTemplateId(id: string): string {
  return id.replace(/^item[-_]?/i, "");
}

function resolveTemplateIconName(item: ClientSceneItem): string | undefined {
  return item.img?.trim() || undefined;
}

function scheduledIcon(id: string): AutomationScheduledTemplateIconName {
  const normalized = normalizeTemplateId(id).toLowerCase();
  if (normalized.includes("morning") || normalized.includes("standup")) return "target";
  if (normalized.includes("risk") || normalized.includes("ci")) return "activity";
  if (normalized.includes("release") || normalized.includes("file")) return "file";
  return "list";
}

function hasLocalizedTitle(item: ClientSceneItem): boolean {
  return Boolean(item.labels.cn?.trim() || item.labels.en?.trim());
}

function resolveReferencedCronExpr(
  scene: ClientSceneConfig,
  promptItem: ClientSceneItem,
  isValidCronExpr: (cronExpr: string) => boolean,
): string | null {
  const cronItemIds = promptItem.defaults?.cronExpr;
  const cronItems = scene.options.cronExpr?.items;
  if (!cronItemIds?.length || !cronItems) return null;

  for (const cronItemId of cronItemIds) {
    const cronItem = cronItems.find((item) => item.id === cronItemId);
    if (!cronItem) continue;
    const localizedValues = [cronItem.contents.en, cronItem.contents.cn]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const cronExpr = localizedValues[0];
    if (!cronExpr) continue;
    // cron 不是自然语言；不同 locale 配置成不同表达式会让点击结果不可预测，按非法配置拒绝。
    if (localizedValues.some((value) => value !== cronExpr)) return null;
    // Croner 支持六/七段等表达式，但 Automation builder 只能无损编辑其中的
    // 五段子集。只做 Service 校验会让模板在打开表单后、用户尚未编辑时就被静默改写。
    if (isValidCronExpr(cronExpr) && canVisualizeCronInAutomationEditor(cronExpr)) {
      return cronExpr;
    }
  }
  return null;
}

function mapScheduledTemplates(
  scenes: readonly ClientSceneConfig[],
  isValidCronExpr: (cronExpr: string) => boolean,
): Pick<AutomationTemplateCatalog, "scheduled" | "rejectedScheduledTemplateIds"> {
  const scene = scenes.find((candidate) => candidate.scene === "scheduled-task");
  const items = scene?.options.prompts?.items ?? [];
  if (!scene) return { scheduled: [], rejectedScheduledTemplateIds: [] };

  const scheduled: ScheduledAutomationTemplate[] = [];
  const rejectedScheduledTemplateIds: string[] = [];
  for (const item of items) {
    if (!hasLocalizedTitle(item)) {
      rejectedScheduledTemplateIds.push(item.id);
      continue;
    }
    const cronExpr = resolveReferencedCronExpr(scene, item, isValidCronExpr);
    if (!cronExpr) {
      rejectedScheduledTemplateIds.push(item.id);
      continue;
    }
    const iconName = resolveTemplateIconName(item);
    scheduled.push({
      id: item.id,
      ...(iconName ? { iconName } : {}),
      title: item.labels,
      description: item.contents,
      prompt: item.contents,
      cronExpr,
      icon: scheduledIcon(item.id),
    });
  }
  return { scheduled, rejectedScheduledTemplateIds };
}

export function mapClientScenesToAutomationTemplates(
  scenes: readonly ClientSceneConfig[],
  isValidCronExpr: (cronExpr: string) => boolean,
): AutomationTemplateCatalog {
  return mapScheduledTemplates(scenes, isValidCronExpr);
}

export function resolveAutomationTemplateText(
  text: AutomationTemplateLocalizedText,
  locale?: string,
): string {
  const isChinese = locale?.startsWith("zh") ?? false;
  const primary = isChinese ? text.cn : text.en;
  const fallback = isChinese ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}

export function materializeScheduledTemplateDraft(
  template: ScheduledAutomationTemplate,
  locale: string,
): { templateId: string; title: string; cronExpr: string; prompt: string } {
  return {
    templateId: template.id,
    title: resolveAutomationTemplateText(template.title, locale),
    cronExpr: template.cronExpr,
    prompt: resolveAutomationTemplateText(template.prompt, locale),
  };
}

/**
 * [leo] 官方模板来自 ZCode 服务端，LeoBot 拿不到，自动化页因此一直没有「从模板开始」。
 * 服务端没给模板时用这三条本地模板兜底；点击只预填新建页，用户确认后才创建。
 */
export const LEO_LOCAL_SCHEDULED_TEMPLATES: readonly ScheduledAutomationTemplate[] = [
  {
    id: "leo-daily-brief",
    icon: "target",
    cronExpr: "0 9 * * *",
    title: { cn: "每日早报", en: "Daily brief" },
    description: {
      cn: "每天早上汇总昨天各项任务的结果和今天待办。",
      en: "Every morning, summarize yesterday's task results and today's to-dos.",
    },
    prompt: {
      cn: "回顾这个项目昨天的任务和会话：列出完成了什么、哪些失败或卡住（附原因），以及今天最该先做的三件事。结论先行，控制在 15 行以内。",
      en: "Review yesterday's tasks and sessions in this project: list what finished, what failed or stalled (with the reason), and the three most important things to do today. Lead with the conclusion, 15 lines max.",
    },
  },
  {
    id: "leo-repo-health",
    icon: "activity",
    cronExpr: "0 18 * * 1-5",
    title: { cn: "下班前跑一遍测试", en: "End-of-day test run" },
    description: {
      cn: "工作日 18:00 拉取最新代码并跑测试，失败时说明原因。",
      en: "On weekdays at 18:00, pull the latest code and run the tests; explain any failure.",
    },
    prompt: {
      cn: "拉取当前分支最新代码，运行项目的测试命令。全部通过就回复一句「测试全绿」；有失败时列出失败用例、错误原文和最可能的原因，不要改代码。",
      en: "Pull the latest code on the current branch and run the project's tests. If everything passes, reply 'All green'. Otherwise list the failing tests, the exact errors and the most likely cause. Do not change code.",
    },
  },
  {
    id: "leo-weekly-review",
    icon: "file",
    cronExpr: "0 20 * * 0",
    title: { cn: "每周回顾", en: "Weekly review" },
    description: {
      cn: "周日晚上把这周的改动整理成一页回顾。",
      en: "Sunday evening, turn this week's changes into a one-page review.",
    },
    prompt: {
      cn: "整理这个项目本周的提交和完成的任务，写一页回顾：做成了什么、还有什么没收尾、下周建议先做什么。用大白话，不超过 20 行。",
      en: "Go through this week's commits and finished tasks in this project and write a one-page review: what shipped, what is still open, and what to do first next week. Plain language, 20 lines max.",
    },
  },
];
