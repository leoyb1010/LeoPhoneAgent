import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * [leo][wp-61] 设置「智能体 → 记忆」:召回的两个来源与各自开关。两者走同一个召回入口
 * (每回合把相关条目作为「可能相关的记忆」附给 agent),来源不同:
 * - 项目记忆(语义召回):让当前模型从本工作区的记忆文件里挑相关的几条。不用 embedding、
 *   不连官方端点,走你配置的模型供应商;模型不支持结构化输出时自动退回记忆索引。
 * - 藏宝阁:按你这句话的关键词在本机藏宝阁里检索,命中的收藏附上(本机检索,不上传)。
 */
export function LeoMemoryRecallSources({
  memoryEnabled,
  semanticRecallEnabled,
  treasuryRecallEnabled,
  onChange,
}: {
  memoryEnabled: boolean;
  semanticRecallEnabled: boolean;
  treasuryRecallEnabled: boolean;
  onChange: (patch: {
    memorySemanticRecallEnabled?: boolean;
    memoryTreasuryRecallEnabled?: boolean;
  }) => void;
}) {
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  return (
    <section
      aria-label={zh ? "召回来源" : "Recall sources"}
      data-testid="leo-memory-recall-sources"
      className="space-y-2"
    >
      <div className="px-1">
        <p className="text-ui-base font-medium text-foreground">{zh ? "召回来源" : "Recall sources"}</p>
        <p className="text-ui-sm text-foreground-subtle">
          {zh
            ? "每个回合开始时，从下面打开的来源里找出和这句话相关的内容，作为「可能相关的记忆」附给 agent；对新建或重新打开的任务生效。"
            : "At the start of each turn, relevant entries from the enabled sources below are attached as possible context for the agent. Applies to new or reopened tasks."}
        </p>
      </div>
      <SettingsGroupCard>
        <SettingsRow
          rowId="leo-memory-recall-semantic"
          label={zh ? "项目记忆（语义召回）" : "Workspace memory (semantic recall)"}
          description={
            memoryEnabled
              ? zh
                ? "由当前模型从本工作区的记忆文件里挑出最相关的几条。不用向量库、不连官方服务，走你配置的模型供应商；模型不支持结构化输出时自动退回记忆索引。"
                : "Uses your configured model to select the most relevant entries from workspace memory files without an external vector service; falls back to the memory index if structured output is unsupported."
              : zh
                ? "需要先打开上面的「工作区记忆」。"
                : "Enable Workspace Memory above first."
          }
          control={
            <Switch
              aria-label={zh ? "项目记忆语义召回" : "Workspace memory semantic recall"}
              data-testid="leo-memory-recall-semantic"
              disabled={!memoryEnabled}
              checked={memoryEnabled && semanticRecallEnabled}
              onCheckedChange={(checked) => onChange({ memorySemanticRecallEnabled: checked })}
            />
          }
        />
        <SettingsRow
          rowId="leo-memory-recall-treasury"
          label={zh ? "藏宝阁" : "Treasury"}
          description={
            zh
              ? "按你这句话的关键词在本机藏宝阁里检索，把相关的收藏（笔记、链接、文本）附上。只在本机检索，不上传；不受「工作区记忆」开关影响。"
              : "Searches your local Treasury by keywords from your prompt and attaches matching notes, links, or snippets. Local only; independent of Workspace Memory."
          }
          control={
            <Switch
              aria-label={zh ? "藏宝阁召回" : "Treasury recall"}
              data-testid="leo-memory-recall-treasury"
              checked={treasuryRecallEnabled}
              onCheckedChange={(checked) => onChange({ memoryTreasuryRecallEnabled: checked })}
            />
          }
        />
      </SettingsGroupCard>
    </section>
  );
}
