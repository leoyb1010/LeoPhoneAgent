import { Switch } from "@/components/ui/switch.js";
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
  return (
    <section aria-label="召回来源" data-testid="leo-memory-recall-sources" className="space-y-2">
      <div className="px-1">
        <p className="text-ui-base font-medium text-foreground">召回来源</p>
        <p className="text-ui-sm text-foreground-subtle">
          每个回合开始时，从下面打开的来源里找出和这句话相关的内容，作为「可能相关的记忆」附给
          agent；对新建或重新打开的任务生效。
        </p>
      </div>
      <SettingsGroupCard>
        <SettingsRow
          rowId="leo-memory-recall-semantic"
          label="项目记忆（语义召回）"
          description={
            memoryEnabled
              ? "由当前模型从本工作区的记忆文件里挑出最相关的几条。不用向量库、不连官方服务，走你配置的模型供应商；模型不支持结构化输出时自动退回记忆索引。"
              : "需要先打开上面的「工作区记忆」。"
          }
          control={
            <Switch
              aria-label="项目记忆语义召回"
              data-testid="leo-memory-recall-semantic"
              disabled={!memoryEnabled}
              checked={memoryEnabled && semanticRecallEnabled}
              onCheckedChange={(checked) => onChange({ memorySemanticRecallEnabled: checked })}
            />
          }
        />
        <SettingsRow
          rowId="leo-memory-recall-treasury"
          label="藏宝阁"
          description="按你这句话的关键词在本机藏宝阁里检索，把相关的收藏（笔记、链接、文本）附上。只在本机检索，不上传；不受「工作区记忆」开关影响。"
          control={
            <Switch
              aria-label="藏宝阁召回"
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
