import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { SECTION_SETTINGS_SEARCH_ROWS } from "@/settings/sectionSearchRows.js";
import {
  GENERAL_SETTINGS_SEARCH_ROWS,
  type createSettingsPageConfig,
} from "@/settings/settingsPageConfig.js";

/** 设置导航搜索的一条候选：分区、扩展 tab 或「常规」里的一行。 */
export interface SettingsSearchCandidate {
  key: string;
  sectionId: SettingsSectionId;
  /** 命中「常规」里的具体行时用于滚动定位。 */
  rowId?: string;
  label: string;
  /** 结果右侧的弱提示（所属分区）。 */
  context?: string;
  haystack: string;
  /** 小写的显示名，用于排序：名字里命中的排在只靠关键词命中的前面。 */
  labelLower: string;
}

type SettingsPageConfig = ReturnType<typeof createSettingsPageConfig>;

export function buildSettingsSearchCandidates({
  config,
  formatMessage,
  isDesktop,
  isWindowsDesktop,
  isWindowsHost,
}: {
  config: SettingsPageConfig;
  formatMessage: (id: string) => string;
  isDesktop: boolean;
  isWindowsDesktop: boolean;
  isWindowsHost: boolean;
}): SettingsSearchCandidate[] {
  const candidates: SettingsSearchCandidate[] = [];
  const add = (
    candidate: Omit<SettingsSearchCandidate, "haystack" | "labelLower">,
    extra: string[],
  ) => {
    candidates.push({
      ...candidate,
      haystack: [candidate.label, candidate.context ?? "", ...extra].join(" ").toLowerCase(),
      labelLower: candidate.label.toLowerCase(),
    });
  };

  for (const group of config.settingsSectionGroups) {
    for (const entry of group.sections) {
      add(
        {
          key: `section:${entry.id}`,
          sectionId: entry.id,
          label: formatMessage(entry.titleId),
        },
        [entry.hintId ? formatMessage(entry.hintId) : "", entry.keywords ?? ""],
      );
    }
  }

  const extensionsLabel = config.extensionsNavEntry
    ? formatMessage(config.extensionsNavEntry.titleId)
    : undefined;
  for (const tab of config.extensionSections) {
    add(
      {
        key: `section:${tab.id}`,
        sectionId: tab.id,
        label: formatMessage(tab.titleId),
        context: extensionsLabel,
      },
      [tab.keywords ?? ""],
    );
  }

  if (config.settingsSections.some((section) => section.id === "general")) {
    const generalLabel = formatMessage("settings.systemTitle");
    for (const row of GENERAL_SETTINGS_SEARCH_ROWS) {
      if (row.requires === "desktop" && !isDesktop) continue;
      if (row.requires === "windowsDesktop" && !isWindowsDesktop) continue;
      if (row.requires === "windowsHost" && !isWindowsHost) continue;
      add(
        {
          key: `row:${row.rowId}`,
          sectionId: "general",
          rowId: row.rowId,
          label: formatMessage(row.labelId),
          context: generalLabel,
        },
        [row.keywords],
      );
    }
  }

  const sectionLabels = new Map<string, string>();
  for (const section of config.settingsSections) sectionLabels.set(section.id, formatMessage(section.titleId));
  for (const row of SECTION_SETTINGS_SEARCH_ROWS) {
    const context = sectionLabels.get(row.sectionId);
    if (!context) continue; // 这个平台没有该分区（例如 Web 端没有电脑操作）
    add(
      {
        key: `row:${row.sectionId}:${row.label}`,
        sectionId: row.sectionId,
        ...(row.rowId ? { rowId: row.rowId } : {}),
        label: row.label,
        context,
      },
      [row.keywords],
    );
  }

  return candidates;
}

function scoreCandidate(candidate: SettingsSearchCandidate, tokens: readonly string[]): number {
  let score = 0;
  for (const token of tokens) {
    if (candidate.labelLower.startsWith(token)) score += 400;
    else if (candidate.labelLower.includes(token)) score += 300;
    else score += 100;
  }
  return score;
}

/**
 * 空白分词，所有词都要出现在 label + hint + 关键词 + 所属分区里（不区分大小写）。
 * [leo] 1.9.0：结果按命中位置排序——名字开头命中 > 名字包含 > 只靠关键词命中，同分保持原顺序。
 * 之前按候选声明顺序返回，搜「代理」时「子智能体」（关键词里有「子代理」）排第一，回车跳错页。
 */
export function filterSettingsSearchCandidates(
  query: string,
  candidates: readonly SettingsSearchCandidate[],
): SettingsSearchCandidate[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => tokens.every((token) => candidate.haystack.includes(token)))
    .map((entry) => ({ ...entry, score: scoreCandidate(entry.candidate, tokens) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ candidate }) => candidate);
}
