import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
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
import { announceAgentIntent, commitAgentForNewSession } from './agentIntent';
import { useTaskDraft } from './useTaskDraft';
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
  active?: boolean;
  project: Project | null;
  localName: string;
  remotes: FleetMachine[];
  onOpenAgentSettings: () => void;
  onOpenProjects: () => void;
  onStartLocalRun: (prompt: string) => void;
  onStartRemoteRun: (machine: FleetMachine, prompt: string, provider: string, effort: string) => Promise<boolean>;
};

/**
 * 唯一任务坞 —— 只在“新任务”表面出现:选谁(Agent)、在哪(@目标)、用什么授权
 * (权限模式)、想多深(推理强度)、干什么(输入框),回车就跑。
 * 已有会话只显示会话自己的 composer,因此整个窗口任何时刻只有一个提交输入框。
 */
export default function CommandBar({
  active = true,
  project,
  localName,
  remotes,
  onOpenAgentSettings,
  onOpenProjects,
  onStartLocalRun,
  onStartRemoteRun,
}: CommandBarProps) {
  const { t } = useTranslation();
  const { preferences, updatePreferences } = useAppPreferences();
  const { agents } = useLocalAgents();
  const [target, setTarget] = useState('');
  const [effort, setEffort] = useState(DEFAULT_EFFORT_VALUE);
  const inputRef = useRef<HTMLInputElement>(null);

  const provider = preferences.defaultProvider as LLMProvider;
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

  const sendTask = useCallback((prompt: string) => {
    const machine = targetOptions.find((option) => option.value === target)?.machine ?? null;
    if (machine) return onStartRemoteRun(machine, prompt, provider, effort);
    // Preserve the existing single-submit path and provider handoff to chat.
    commitAgentForNewSession(provider, effort);
    onStartLocalRun(prompt);
    return true;
  }, [effort, onStartLocalRun, onStartRemoteRun, provider, target, targetOptions]);
  const { draft, setDraft, submit, busy, error } = useTaskDraft(sendTask);

  // ⌘/Ctrl + L 和标题栏「新任务」都把焦点带回指挥条,不用摸鼠标。
  useEffect(() => {
    if (!active) return undefined;
    const focusInput = () => inputRef.current?.focus();
    focusInput();
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        focusInput();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('leocodebox:focus-command-bar', focusInput);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('leocodebox:focus-command-bar', focusInput);
    };
  }, [active]);

  return (
    <div className="relative z-30 flex flex-none flex-col items-center pt-4">
      <div className="wb-command-bar flex h-14 w-[820px] max-w-[calc(100vw-48px)] items-center gap-2 rounded-[17px] pl-3 pr-2.5">
        <ChipMenu
          value={provider}
          onSelect={(next) => void updatePreferences({ defaultProvider: next as LLMProvider })}
          tooltip={t('workbench.agentTooltip', { defaultValue: '为新任务选择 Agent' })}
          ariaLabel={t('workbench.agentTooltip', { defaultValue: '为新任务选择 Agent' })}
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
              {t('workbench.agentMenuFooter', { defaultValue: '安装 / 更新 / 登录 → 设置 · 模型与智能体' })}
            </button>
          }
        >
          <SessionProviderLogo provider={provider} className="h-[17px] w-[17px]" />
          <span className="text-xs font-semibold text-foreground">{agentLabel}</span>
        </ChipMenu>

        {/*
          没选项目时输入框也保持可用:回车后由 startLocalRun 排队这句话并打开项目
          抽屉,选完项目自动发出。以前直接 disabled,配合"先在 ⌘K 里选一个项目"
          的占位文案,新任务页看上去就是一个点不动的假输入框。
        */}
        <input
          ref={inputRef}
          autoFocus={active}
          aria-busy={busy}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && active) {
              event.preventDefault();
              void submit();
            }
          }}
          aria-label={t('workbench.commandInputLabel', { defaultValue: '新任务' })}
          placeholder={
            project
              ? t('workbench.commandPlaceholder', {
                agent: agentLabel,
                target: target || localLabel,
                defaultValue: `让 ${agentLabel} 在 ${target || localLabel} 上做点什么…`,
              })
              : t('workbench.commandNoProject', { defaultValue: '先说要做什么，回车后选项目…' })
          }
          className="min-w-0 flex-1 border-none bg-transparent font-sans text-[15px] text-foreground outline-none placeholder:text-wb-faint"
        />

        <Tooltip content={project?.fullPath || t('workbench.pickProject', { defaultValue: '选择任务项目' })} position="bottom">
          <button
            type="button"
            onClick={onOpenProjects}
            aria-label={t('workbench.pickProject', { defaultValue: '选择任务项目' })}
            className="wb-chip-button h-[26px] max-w-[170px] gap-1.5 rounded-lg px-2.5 text-[10.5px]"
          >
            <FolderOpen className="h-3 w-3 flex-none" />
            <span className="truncate">{project?.displayName || t('workbench.noProject', { defaultValue: '选项目' })}</span>
          </button>
        </Tooltip>

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
      {error && <p role="alert" className="mt-2 max-w-[820px] px-4 text-sm text-destructive">{error}</p>}
    </div>
  );
}
