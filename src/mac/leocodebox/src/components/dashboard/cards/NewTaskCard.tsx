import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { LLMProvider } from '../../../types/app';
import ChipMenu from '../../workbench/ChipMenu';
import { commitAgentForNewSession } from '../../workbench/agentIntent';
import type {
  ConsoleAgentOption,
  ConsoleMachineOption,
  ConsoleProjectOption,
  NewTaskLaunch,
} from '../newTask';

import { DashCard, DashCardTitle, StatusDot } from './dashShared';

type NewTaskCardProps = {
  agents: ConsoleAgentOption[];
  machines: ConsoleMachineOption[];
  projects: ConsoleProjectOption[];
  /** 用户在设置里定的默认 Agent;这里只当初始值,不回写。 */
  defaultProvider: string;
  /** 外壳当前选中的项目,作为目录的初始值。 */
  selectedProjectId: string | null;
  onStartTask: (launch: NewTaskLaunch) => void;
  onOpenAgentSettings: () => void;
  onOpenProjects: () => void;
  delay?: number;
};

/**
 * 主控台的「新任务」 —— 换 Agent 这件事唯一不产生歧义的落点。
 *
 * ── 为什么它必须长在主控台上 ────────────────────────────────────
 * 1.68 把首页删了("对话即首页"),于是所有 Agent 切换都被迫发生在一个
 * **已经绑定了 Agent 的会话内部**:用户点下 Codex,代码没法知道他是想把
 * 这个 Claude 会话改成 Codex(做不到,会话的 provider 建会话时就写死了),
 * 还是想开一个新的 Codex 会话。猜错就是三轮没修干净的「选了 Codex,发出去
 * 还是 Claude」。这张卡片所在的地方还没有任何会话,所以"选 Agent"只有一种
 * 意思:**下一个新会话用它**。
 *
 * ── 为什么选 Agent 不写全局默认 ────────────────────────────────
 * 主控台上仍然可能有一个 selectedSession 挂在外壳里(用户是从某个会话点回来的)。
 * 如果在**点选那一刻**就把全局 provider 改掉,用户再点回那个会话时,composer 的
 * provider 已经是 Codex 了 —— 又回到同一个 bug。所以选择只存在这张卡片的局部
 * state 里,直到用户真的按下「开始」才 commitAgentForNewSession:那一刻外壳会把
 * selectedSession 清空去开新会话,交出去的对象只可能是这个新会话。
 */
export default function NewTaskCard({
  agents,
  machines,
  projects,
  defaultProvider,
  selectedProjectId,
  onStartTask,
  onOpenAgentSettings,
  onOpenProjects,
  delay = 0,
}: NewTaskCardProps) {
  const { t } = useTranslation();
  // null = 还没手动选过,跟随外部默认值(preferences 是异步加载的,不能用初始值定死)。
  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const [machine, setMachine] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const provider = pickedProvider ?? defaultProvider;
  const projectId = pickedProjectId ?? selectedProjectId ?? projects[0]?.projectId ?? null;

  const agent = agents.find((item) => item.provider === provider);
  const agentLabel = agent?.label ?? provider;
  const project = projects.find((item) => item.projectId === projectId);
  const machineLabel = machines.find((item) => item.name === machine)?.label
    ?? t('dashboard.newTaskLocal', { defaultValue: '本机' });

  const machineOptions = useMemo(
    () => machines.map((item) => ({
      // ChipMenu 的 value 是字符串;本机用空串代表 null。
      value: item.name ?? '',
      label: item.label,
      desc: item.desc,
    })),
    [machines],
  );

  const canSubmit = Boolean(draft.trim() && projectId);

  const submit = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || !projectId) return;
    // 本机任务:先把 Agent 交给会话侧(事件 + 挂载时读的那把钥匙,见 agentIntent.ts),
    // 再交给外壳开会话。远程任务不经本机 composer,harness 直接跟着 launch 发给中继,
    // 在这里改本机 provider 反而是副作用。
    if (!machine) commitAgentForNewSession(provider);
    setDraft('');
    onStartTask({ provider: provider as LLMProvider, projectId, machine, prompt });
  }, [draft, machine, onStartTask, projectId, provider]);

  return (
    <DashCard delay={delay} className="p-4">
      <DashCardTitle
        title={t('dashboard.newTaskTitle', { defaultValue: '新任务' })}
        action={(
          <span className="text-[12px] text-muted-foreground">
            {t('dashboard.newTaskHint', { defaultValue: 'Agent 在这里选;会话建好后不再更换' })}
          </span>
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <ChipMenu
          value={provider}
          onSelect={setPickedProvider}
          tooltip={t('dashboard.newTaskAgentTooltip', { defaultValue: '为这个新会话选 Agent' })}
          ariaLabel={t('dashboard.newTaskAgentTooltip', { defaultValue: '为这个新会话选 Agent' })}
          className="h-8 gap-2 rounded-lg px-2.5 text-[12.5px]"
          menuClassName="w-60"
          options={agents.map((item) => ({
            value: item.provider,
            label: item.label,
            desc: item.status,
            disabled: item.disabled,
            icon: <StatusDot tone={item.disabled ? 'idle' : 'ok'} />,
          }))}
          footer={(
            <button
              type="button"
              onClick={onOpenAgentSettings}
              className="mx-1.5 mb-0.5 mt-1.5 block w-[calc(100%-12px)] cursor-pointer border-t border-border bg-transparent pt-1.5 text-left text-[9.5px] text-wb-faint hover:text-muted-foreground"
            >
              {t('workbench.agentMenuFooter', { defaultValue: '安装 / 更新 / 登录 → 设置 · 本机智能体' })}
            </button>
          )}
        >
          <span className="font-medium text-foreground">{agentLabel}</span>
        </ChipMenu>

        <ChipMenu
          value={machine ?? ''}
          onSelect={(next) => setMachine(next || null)}
          tooltip={t('dashboard.newTaskMachineTooltip', { defaultValue: '任务跑在哪台机器上' })}
          ariaLabel={t('dashboard.newTaskMachineTooltip', { defaultValue: '任务跑在哪台机器上' })}
          className="h-8 rounded-lg px-2.5 font-mono text-[11.5px] text-primary"
          options={machineOptions}
        >
          @ {machineLabel}
        </ChipMenu>

        <ChipMenu
          value={projectId ?? ''}
          onSelect={setPickedProjectId}
          tooltip={t('dashboard.newTaskProjectTooltip', { defaultValue: '任务的工作目录' })}
          ariaLabel={t('dashboard.newTaskProjectTooltip', { defaultValue: '任务的工作目录' })}
          className="h-8 max-w-[280px] rounded-lg px-2.5 text-[12.5px]"
          menuClassName="w-72"
          options={projects.map((item) => ({
            value: item.projectId,
            label: item.displayName,
            desc: item.path,
          }))}
          footer={(
            <button
              type="button"
              onClick={onOpenProjects}
              className="mx-1.5 mb-0.5 mt-1.5 block w-[calc(100%-12px)] cursor-pointer border-t border-border bg-transparent pt-1.5 text-left text-[9.5px] text-wb-faint hover:text-muted-foreground"
            >
              {t('dashboard.newTaskManageProjects', { defaultValue: '添加 / 管理项目…' })}
            </button>
          )}
        >
          <span className="truncate">
            {project?.displayName ?? t('dashboard.newTaskNoProject', { defaultValue: '未选目录' })}
          </span>
        </ChipMenu>
      </div>

      <div className="mt-3 flex items-end gap-2">
        <textarea
          value={draft}
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          aria-label={t('dashboard.newTaskPromptLabel', { defaultValue: '第一句话' })}
          placeholder={t('dashboard.newTaskPlaceholder', {
            agent: agentLabel,
            target: project?.displayName ?? machineLabel,
            defaultValue: `让 ${agentLabel} 在 ${project?.displayName ?? machineLabel} 上做点什么…`,
          })}
          className="min-h-[52px] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/60"
        />
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          aria-label={t('dashboard.newTaskStart', { defaultValue: '开始新会话' })}
          className="h-9 flex-none rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {t('dashboard.newTaskStart', { defaultValue: '开始新会话' })}
        </button>
      </div>

      {!projectId && (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {t('dashboard.newTaskNeedProject', { defaultValue: '先添加一个项目目录,任务才有落脚点。' })}
        </p>
      )}
    </DashCard>
  );
}
