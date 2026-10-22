import type { ClientSceneConfig, ClientSceneItem } from "@zcode/services";
import { LEO_AUTOMATION_TEMPLATES } from "@zcode/shared/leo-automation-templates";
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
 * 模板内容和手机 `GET /automations/templates` 共用 `@zcode/shared/leo-automation-templates`。
 */
export const LEO_LOCAL_SCHEDULED_TEMPLATES: readonly ScheduledAutomationTemplate[] =
  LEO_AUTOMATION_TEMPLATES.map(({ id, icon, cronExpr, title, description, prompt }) => ({
    id,
    icon,
    cronExpr,
    title,
    description,
    prompt,
  }));
