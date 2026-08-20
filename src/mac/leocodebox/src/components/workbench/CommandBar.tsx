import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';
import SessionProviderLogo from '../llm-logo-provider/SessionProviderLogo';
import { useAppPreferences } from '../../contexts/PreferencesContext';
import {
  DEFAULT_EFFORT_VALUE,
  FALLBACK_PROVIDER_EFFORT_VALUES,
} from '../chat/constants/providerEffort';
import { FALLBACK_PERMISSION_MODES } from '../chat/constants/providerPermissions';
import type { LLMProvider, Project } from '../../types/app';

import ChipMenu from './ChipMenu';
import { announceAgentIntent, commitAgentForNewSession, resolveCommandBarAgent } from './agentIntent';
import { useLocalAgents } from './useLocalAgents';
import { isMachineOnline, isMinisBody, type FleetMachine } from './useFleetSnapshot';

type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';

/** 五档权限模式。desc 写清楚每一档到底放开了什么 —— 选错代价最大的就是这个控件。 */
const PERMISSION_MODES: { id: PermissionMode; label: string; desc: string; dot: string }[] = [
  { id: 'default', label: '默认审批', desc: '每个写操作和命令都问你', dot: 'bg-muted-foreground' },
  { id: 'plan', label: '计划模式', desc: '只读与规划,不落任何改动', dot: 'bg-wb-accent2' },
  { id: 'acceptEdits', label: '接受编辑', desc: '文件改动自动放行,命令仍要审批', dot: 'bg-primary' },
  { id: 'auto', label: '全自动', desc: '常规操作全放行,高危仍拦截', dot: 'bg-warning' },
  { id: 'bypassPermissions', label: '跳过审批', desc: '不再询问任何操作,谨慎使用', dot: 'bg-destructive' },
];

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
  opencode: 'OpenCode',
};

const EFFORT_DESC: Record<string, string> = {
  default: '用该 Agent 自己的默认档',
  low: '最快,适合机械改动',
  medium: '速度与深度均衡',
  high: '更长的推理,适合疑难问题',
  xhigh: '很长的推理,慢但更稳',
  max: '不限推理长度,最慢',
  none: '关闭额外推理',
};

type CommandBarProps = {
  project: Project | null;
  localName: string;
  remotes: FleetMachine[];
  /** 当前选中会话建会话时定下的 Agent;没有选中会话时为 null。 */
  sessionProvider: string | null;
  onOpenAgentSettings: () => void;
  /** 回主控台 —— 锁住的 Agent 芯片点下去就去那儿换。 */
  onOpenConsole: () => void;
  onStartLocalRun: (prompt: string) => void;
  onStartRemoteRun: (machine: FleetMachine, prompt: string, provider: string, effort: string) => Promise<boolean>;
};

/**
 * 指挥条 —— 一条 820px 的悬浮条:选谁(Agent)、在哪(@目标)、用什么授权
 * (权限模式)、想多深(推理强度)、干什么(输入框),回车就跑。
 *
 * ── Agent 芯片:为什么在会话里是锁的(方案 b) ───────────────────
 * 这条指挥条常驻在最上面,而它下面可能是主控台(还没有会话),也可能是一个
 * **建会话时就把 Agent 定死了**的已有会话。同一个下拉在两种语境下含义不同,
 * 就是歧义本身:在会话里点它,看起来像"把这个会话换成 Codex",实际上只改了
 * 一个全局默认值 —— 于是"芯片写着 Codex、发出去还是 Claude"。
 *
 * 收敛方式:**选中了会话 → 芯片只显示该会话的 Agent,不可选**,点它回主控台
 * 开新任务;**没有选中会话(主控台 / 新会话)→ 芯片才是选择器**,这时候
 * "选 Agent"只有一种意思:下一个新会话用它。判据抽在 resolveCommandBarAgent。
 * 权限模式与推理强度也跟着这个"当前生效的 Agent"走,不再按全局默认置灰。
 */
export default function CommandBar({
  project,
  localName,
  remotes,
  sessionProvider,
  onOpenAgentSettings,
  onOpenConsole,
  onStartLocalRun,
  onStartRemoteRun,
}: CommandBarProps) {
  const { t } = useTranslation();
  const { preferences, updatePreferences } = useAppPreferences();
  const { agents } = useLocalAgents();
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('');
  const [effort, setEffort] = useState(DEFAULT_EFFORT_VALUE);
  const inputRef = useRef<HTMLInputElement>(null);

  const resolvedAgent = resolveCommandBarAgent({
    sessionProvider,
    preferredProvider: preferences.defaultProvider,
  });
  const provider = resolvedAgent.provider as LLMProvider;
  const agentLocked = resolvedAgent.locked;
  const permission = (preferences.permissionMode ?? 'default') as PermissionMode;
  const permissionMeta = PERMISSION_MODES.find((mode) => mode.id === permission) ?? PERMISSION_MODES[0];
  const agentLabel = PROVIDER_LABEL[provider] ?? provider;
  const localLabel = localName || '本机';

  // 目标 = 本机 + 在线的远程机器。离线机器不进菜单,免得回车打进黑洞。
  const targetOptions = useMemo(
    () => [{ value: localLabel, label: localLabel, desc: '这台 Mac', machine: null as FleetMachine | null }].concat(
      remotes
        .filter(isMachineOnline)
        .map((machine) => ({
          value: machine.name,
          label: machine.name,
          desc: machine.activeCount > 0 ? `${machine.activeCount} 个会话运行中` : '空闲 · 经中继下发',
          machine,
        })),
    ),
    [localLabel, remotes],
  );
  const selectedRemote = targetOptions.find((option) => option.value === target)?.machine ?? null;
  const remoteSupportsThinking = selectedRemote == null || isMinisBody(selectedRemote);

  // 远程机器掉线时把选择收回本机。
  useEffect(() => {
    if (!targetOptions.some((option) => option.value === target)) setTarget(localLabel);
  }, [target, targetOptions, localLabel]);

  // 不是每个 Agent 都吃全部五档权限:Codex 只有三档。以前这里无条件列全,
  // 选了它不支持的档位会在发送时被静默降级回默认档 —— 芯片写着"计划模式",
  // 跑起来却不是。这里按 Agent 把不支持的档位置灰并说明原因。
  const supportedPermissions = FALLBACK_PERMISSION_MODES[provider] ?? PERMISSION_MODES.map((mode) => mode.id);

  // 推理强度按 provider 各存一份(与会话内的 effort 选择器同一把钥匙)。
  const effortOptions = useMemo(
    () => [DEFAULT_EFFORT_VALUE, ...(FALLBACK_PROVIDER_EFFORT_VALUES[provider] ?? [])],
    [provider],
  );

  useEffect(() => {
    setEffort(localStorage.getItem(`${provider}-effort`) || DEFAULT_EFFORT_VALUE);
  }, [provider]);

  const pickEffort = useCallback((next: string) => {
    setEffort(next);
    localStorage.setItem(`${provider}-effort`, next);
    // 会话侧的 provider state 监听这个事件,新会话开出来就是这个档位。
    announceAgentIntent(provider, next);
  }, [provider]);

  const submit = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt) return;
    const machine = targetOptions.find((option) => option.value === target)?.machine ?? null;
    if (machine) {
      void onStartRemoteRun(machine, prompt, provider, effort).then((ok) => {
        if (ok) setDraft('');
      });
      return;
    }
    setDraft('');
    // 先交出 Agent,再开会话。芯片上的选择和会话真正用的 provider 是两份状态,
    // 只靠这条通道对齐;在会话之间点选过之后,之前那次宣告已经被会话跟随逻辑冲掉,
    // 不重新交一次就会拿上一个会话的 provider 建新会话(= 选了 Codex 仍然走 Claude)。
    // 用 commit 而不是只 announce:从主控台按回车时 ChatInterface 还没挂载,事件
    // 没人听得见,得同时落到它挂载时读的那把钥匙上(见 agentIntent.ts)。
    commitAgentForNewSession(provider, effort);
    onStartLocalRun(prompt);
  }, [draft, effort, onStartLocalRun, onStartRemoteRun, provider, target, targetOptions]);

  // ⌘/Ctrl + L 把焦点带回指挥条,不用摸鼠标。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative z-30 flex flex-none justify-center pt-4">
      <div className="wb-command-bar flex h-14 w-[820px] max-w-[calc(100vw-48px)] items-center gap-2 rounded-[17px] pl-3 pr-2.5">
        {agentLocked ? (
          <Tooltip
            content={t('workbench.agentLockedTooltip', { defaultValue: '这个会话建立时就用的它,换 Agent 请回主控台开新任务' })}
            position="bottom"
          >
            <button
              type="button"
              onClick={onOpenConsole}
              aria-label={t('workbench.agentLockedLabel', { agent: agentLabel, defaultValue: `本会话的 Agent:${agentLabel}` })}
              className="wb-chip-button wb-agent-button h-9 gap-[7px] rounded-[10px] px-2.5"
            >
              <SessionProviderLogo provider={provider} className="h-[17px] w-[17px]" />
              <span className="text-xs font-semibold text-foreground">{agentLabel}</span>
              <span aria-hidden className="text-[9px] text-wb-faint">{t('workbench.agentLockedMark', { defaultValue: '本会话' })}</span>
            </button>
          </Tooltip>
        ) : (
          <ChipMenu
            value={provider}
            onSelect={(next) => void updatePreferences({ defaultProvider: next as LLMProvider })}
            tooltip={t('workbench.agentTooltip', { defaultValue: '为下一个新会话选 Agent' })}
            ariaLabel={t('workbench.agentTooltip', { defaultValue: '为下一个新会话选 Agent' })}
            className="wb-agent-button h-9 gap-[7px] rounded-[10px] px-2.5"
            menuClassName="w-60"
            options={agents.map((agent) => ({
              value: agent.provider,
              label: agent.label,
              desc: agent.status,
              icon: <SessionProviderLogo provider={agent.provider} className="h-[15px] w-[15px] flex-none" />,
            }))}
            footer={
              <button
                type="button"
                onClick={onOpenAgentSettings}
                className="mx-1.5 mb-0.5 mt-1.5 block w-[calc(100%-12px)] cursor-pointer border-t border-border bg-transparent pt-1.5 text-left text-[9.5px] text-wb-faint hover:text-muted-foreground"
              >
                {t('workbench.agentMenuFooter', { defaultValue: '安装 / 更新 / 登录 → 设置 · 本机智能体' })}
              </button>
            }
          >
            <SessionProviderLogo provider={provider} className="h-[17px] w-[17px]" />
            <span className="text-xs font-semibold text-foreground">{agentLabel}</span>
          </ChipMenu>
        )}

        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) submit();
          }}
          disabled={!project}
          aria-label={t('workbench.commandInputLabel', { defaultValue: '新任务' })}
          placeholder={
            project
              ? t('workbench.commandPlaceholder', {
                agent: agentLabel,
                target: target || localLabel,
                defaultValue: `让 ${agentLabel} 在 ${target || localLabel} 上做点什么…`,
              })
              : t('workbench.commandNoProject', { defaultValue: '先在 ⌘K 里选一个项目…' })
          }
          className="min-w-0 flex-1 border-none bg-transparent font-sans text-[15px] text-foreground outline-none placeholder:text-wb-faint disabled:cursor-not-allowed"
        />

        <ChipMenu
          value={target}
          onSelect={setTarget}
          align="right"
          tooltip={t('workbench.targetTooltip', { defaultValue: '任务目标:本机或远程机器' })}
          ariaLabel={t('workbench.targetTooltip', { defaultValue: '任务目标' })}
          className="h-[26px] rounded-lg px-2.5 font-mono text-[10.5px] text-primary"
          options={targetOptions.map(({ value, label, desc }) => ({ value, label, desc }))}
        >
          @ {target || localLabel}
        </ChipMenu>

        {selectedRemote ? (
          <Tooltip content="远程机器使用它自己的审批策略" position="bottom">
            <span className="wb-chip-button h-[26px] rounded-lg px-2.5 text-[10.5px] text-wb-faint">远程端审批</span>
          </Tooltip>
        ) : (
          <ChipMenu
            value={permission}
            onSelect={(next) => void updatePreferences({ permissionMode: next as PermissionMode })}
            align="right"
            tooltip={t('workbench.permissionTooltip', { defaultValue: '权限模式:控制工具授权策略' })}
            ariaLabel={t('workbench.permissionTooltip', { defaultValue: '权限模式' })}
            className="h-[26px] gap-1.5 rounded-lg px-2.5 text-[10.5px]"
            options={PERMISSION_MODES.map((mode) => {
              const supported = supportedPermissions.includes(mode.id);
              return {
                value: mode.id,
                label: mode.label,
                desc: supported ? mode.desc : `${agentLabel} 不支持这一档`,
                disabled: !supported,
                icon: <span className={cn('h-1.5 w-1.5 flex-none rounded-full', mode.dot)} />,
              };
            })}
          >
            <span className={cn('h-1.5 w-1.5 flex-none rounded-full transition-colors duration-slow', permissionMeta.dot)} />
            {permissionMeta.label}
          </ChipMenu>
        )}

        {remoteSupportsThinking ? <ChipMenu
          value={effort}
          onSelect={pickEffort}
          align="right"
          tooltip={t('workbench.effortTooltip', { defaultValue: '推理强度:开会话前就定,进会话后仍可改' })}
          ariaLabel={t('workbench.effortTooltip', { defaultValue: '推理强度' })}
          className="h-[26px] rounded-lg px-2.5 font-mono text-[10.5px]"
          options={effortOptions.map((option) => ({
            value: option,
            label: option,
            desc: EFFORT_DESC[option],
          }))}
        >
          {effort}
        </ChipMenu> : (
          <Tooltip content="这个 Mac CLI 的远程推理档尚未映射，将使用 CLI 默认值" position="bottom">
            <span className="wb-chip-button h-[26px] rounded-lg px-2.5 font-mono text-[10.5px] text-wb-faint">默认推理</span>
          </Tooltip>
        )}

        <span aria-hidden className="flex-none pr-1 font-mono text-[10px] text-wb-faint">⏎</span>
      </div>
    </div>
  );
}
