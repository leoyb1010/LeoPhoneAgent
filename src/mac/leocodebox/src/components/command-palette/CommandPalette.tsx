import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  CornerUpLeft,
  FileText,
  Gauge,
  GitCommit,
  GitMerge,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Route,
  Settings,
  Stethoscope,
  SunMoon,
  X,
} from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../shared/view/ui';
import { useTheme } from '../../contexts/ThemeContext';
import { usePaletteOps } from '../../contexts/PaletteOpsContext';
import { SETTINGS_MAIN_TABS } from '../settings/constants/constants';
import type { AppTab, Project } from '../../types/app';
import { readHandoffSource } from '../../hooks/projectStateUtils';

import { useSessionsSource } from './sources/useSessionsSource';
import { useFilesSource } from './sources/useFilesSource';
import { useCommitsSource } from './sources/useCommitsSource';
import { useSessionMessageSearch } from './sources/useSessionMessageSearch';
import { useBranchesSource } from './sources/useBranchesSource';
import { useGitActions } from './sources/useGitActions';
import { useLeoapiSwitchSource, type LeoapiSwitchNode } from './sources/useLeoapiSwitchSource';
import { HANDOFF_TARGET_PROVIDERS, useHandoffSource } from './sources/useHandoffSource';

type Page = 'actions' | 'files' | 'sessions' | 'commits' | 'branches' | 'leoapi' | 'handoff';

type CommandPaletteProps = {
  selectedProject: Project | null;
  selectedSession?: { id: string; __provider?: string } | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
};

const NAV_TABS: Array<{ id: AppTab; labelKey: string; keywords: string }> = [
  { id: 'chat', labelKey: 'commandPalette.goChat', keywords: 'chat messages conversation' },
  { id: 'files', labelKey: 'commandPalette.goFiles', keywords: 'files file tree explorer' },
  { id: 'shell', labelKey: 'commandPalette.goShell', keywords: 'shell terminal console' },
  { id: 'git', labelKey: 'commandPalette.goGit', keywords: 'git diff branches' },
  { id: 'tasks', labelKey: 'commandPalette.goTasks', keywords: 'tasks taskmaster' },
];

export default function CommandPalette({
  selectedProject,
  selectedSession = null,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [pages, setPages] = React.useState<Page[]>([]);
  const { toggleDarkMode } = useTheme();
  const navigate = useNavigate();
  const ops = usePaletteOps();

  const page = pages.at(-1);
  const pageLabel = page ? t(`commandPalette.${page}`) : '';

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const [pendingSwitchNode, setPendingSwitchNode] = React.useState<LeoapiSwitchNode | null>(null);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setPages([]);
      setPendingSwitchNode(null);
    }
  }, [open]);

  const projectId = selectedProject?.projectId;

  const showActions = !page || page === 'actions';
  const showSessions = !page || page === 'sessions';
  const showFiles = !page || page === 'files';
  const showCommits = !page || page === 'commits';
  const showBranches = !page || page === 'branches' || page === 'actions';

  const showLeoapi = page === 'leoapi';

  const sessions = useSessionsSource(projectId, open && showSessions);
  const { items: messageMatches, coveredProviders } = useSessionMessageSearch(projectId, search, open && showSessions);
  const files = useFilesSource(projectId, open && showFiles);
  const commits = useCommitsSource(projectId, open && showCommits);
  const branches = useBranchesSource(projectId, open && showBranches);
  const git = useGitActions(projectId);
  const leoapi = useLeoapiSwitchSource(open && showLeoapi);
  const handoff = useHandoffSource();
  const showHandoff = page === 'handoff';
  const currentSessionProvider = selectedSession?.__provider || null;
  // Recomputed each time the palette opens so a fresh return ticket is picked up.
  const handoffSource = React.useMemo(
    () => (open && selectedSession ? readHandoffSource(selectedSession.id) : null),
    [open, selectedSession],
  );

  const runHandoff = React.useCallback(async (targetProvider: string) => {
    if (!selectedSession || !selectedProject) return;
    const text = await handoff.prepare(selectedSession.id, currentSessionProvider || 'agent');
    setOpen(false);
    // Provider switch reuses the preferences event the composer already
    // listens to; the draft event fills the new session's composer.
    window.dispatchEvent(new CustomEvent('leocodebox-preferences:changed', {
      detail: { defaultProvider: targetProvider },
    }));
    onStartNewChat(selectedProject);
    window.dispatchEvent(new CustomEvent('leocodebox:handoff-draft', {
      detail: { text, sourceSessionId: selectedSession.id },
    }));
  }, [selectedSession, selectedProject, currentSessionProvider, handoff, onStartNewChat]);

  const sessionRows = React.useMemo(() => {
    if (!showSessions) return [];
    type Row = { id: string; label: string; provider?: string; snippet?: string };
    const byId = new Map<string, Row>();
    for (const s of sessions) {
      byId.set(s.id, { id: s.id, label: s.label, provider: s.provider });
    }
    for (const m of messageMatches) {
      const existing = byId.get(m.sessionId);
      if (existing) {
        existing.snippet = m.snippet;
      } else {
        byId.set(m.sessionId, {
          id: m.sessionId,
          label: m.label,
          provider: m.provider,
          snippet: m.snippet,
        });
      }
    }
    return Array.from(byId.values());
  }, [sessions, messageMatches, showSessions]);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const pushPage = React.useCallback((next: Page) => {
    setSearch('');
    setPages((prev) => [...prev, next]);
  }, []);

  const popPage = React.useCallback(() => {
    setSearch('');
    setPendingSwitchNode(null);
    setPages((prev) => prev.slice(0, -1));
  }, []);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !search && pages.length > 0) {
      e.preventDefault();
      popPage();
    }
  }, [search, pages.length, popPage]);

  const startNewChatDisabled = !selectedProject;
  const browseLimit = 5;
  const filesShown = page === 'files' ? files : files.slice(0, browseLimit);
  const commitsShown = page === 'commits' ? commits : commits.slice(0, browseLimit);
  const sessionsShown = page === 'sessions' ? sessionRows : sessionRows.slice(0, browseLimit);
  const branchesShown = page === 'branches' ? branches : branches.slice(0, browseLimit);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <Command label={t('commandPalette.title')} onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                {pageLabel}
                <button
                  type="button"
                  onClick={popPage}
                  aria-label={t('commandPalette.back')}
                  className="ml-0.5 rounded-md opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="text-xs text-muted-foreground">{t('commandPalette.backHint')}</span>
            </div>
          )}
          <CommandInput
            placeholder={page ? t('commandPalette.searchPage', { page: pageLabel.toLowerCase() }) : t('commandPalette.searchAll')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>

            {showActions && (
              <CommandGroup heading={t('commandPalette.actions')}>
                <CommandItem
                  value="Start new chat"
                  disabled={startNewChatDisabled}
                  onSelect={() => {
                    if (!selectedProject) return;
                    run(() => onStartNewChat(selectedProject));
                  }}
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.startChat')}</span>
                  {startNewChatDisabled && (
                    <span className="text-xs text-muted-foreground">{t('commandPalette.selectProject')}</span>
                  )}
                </CommandItem>
                <CommandItem value="Open settings" onSelect={() => run(() => onOpenSettings())}>
                  <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.openSettings')}</span>
                </CommandItem>
                <CommandItem value="Toggle theme dark light mode" onSelect={() => run(toggleDarkMode)}>
                  <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.toggleTheme')}</span>
                </CommandItem>
                <CommandItem
                  value="Switch Leoapi node api endpoint 换轨 接口 节点"
                  onSelect={() => pushPage('leoapi')}
                >
                  <Route className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.switchLeoapi')}</span>
                </CommandItem>
                <CommandItem
                  value="Doctor environment health check 环境体检 诊断 健康"
                  onSelect={() => run(() => {
                    window.dispatchEvent(new CustomEvent('leocodebox:doctor-refresh'));
                    window.dispatchEvent(new CustomEvent('leocodebox:open-doctor'));
                  })}
                >
                  <Stethoscope className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.doctor', { defaultValue: '环境体检' })}</span>
                </CommandItem>
                {selectedSession && selectedProject && (
                  <CommandItem
                    value="Handoff to agent 交接 接力 续写"
                    onSelect={() => pushPage('handoff')}
                  >
                    <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{t('commandPalette.handoff')}</span>
                  </CommandItem>
                )}
                {handoffSource && (
                  <CommandItem
                    value="Return to handoff source 回到交接来源 回程 来源"
                    onSelect={() => run(() => navigate(`/session/${handoffSource}`))}
                  >
                    <CornerUpLeft className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{t('commandPalette.handoffReturn')}</span>
                  </CommandItem>
                )}
              </CommandGroup>
            )}

            {showHandoff && (
              <CommandGroup heading={t('commandPalette.handoffHeading')}>
                {HANDOFF_TARGET_PROVIDERS
                  .filter((target) => target !== currentSessionProvider)
                  .map((target) => (
                    <CommandItem
                      key={target}
                      value={`handoff ${target}`}
                      disabled={handoff.preparing}
                      onSelect={() => {
                        void runHandoff(target).catch((error: unknown) => {
                          console.error('Handoff failed:', error);
                        });
                      }}
                    >
                      <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex-1">{t('commandPalette.handoffTo', { provider: target })}</span>
                    </CommandItem>
                  ))}
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  {handoff.preparing ? t('commandPalette.handoffPreparing') : t('commandPalette.handoffHint')}
                </div>
              </CommandGroup>
            )}

            {showLeoapi && !pendingSwitchNode && (
              <CommandGroup heading={t('commandPalette.leoapi')}>
                {leoapi.nodes.map((node) => (
                  <CommandItem
                    key={node.id}
                    value={`${node.name} ${node.target} ${node.baseUrl}`}
                    onSelect={() => setPendingSwitchNode(node)}
                  >
                    <Route className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{node.name}</span>
                    <span className="text-xs text-muted-foreground">{node.target}</span>
                    {node.latencyMs !== null && (
                      <span className="text-xs text-muted-foreground">{node.latencyMs}ms</span>
                    )}
                    {node.isActive && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
                  </CommandItem>
                ))}
                {leoapi.lastResult && (
                  <div className="px-3 py-1.5 text-xs text-muted-foreground">{leoapi.lastResult}</div>
                )}
              </CommandGroup>
            )}

            {showLeoapi && pendingSwitchNode && (
              <CommandGroup heading={pendingSwitchNode.name}>
                <CommandItem
                  value="confirm switch apply 确认 切换"
                  disabled={leoapi.busyNodeId !== null}
                  onSelect={() => {
                    void leoapi.apply(pendingSwitchNode).then(() => {
                      window.dispatchEvent(new CustomEvent('leocodebox:leoapi-switched'));
                      setOpen(false);
                    }).catch(() => {
                      // Transactional apply rolls back server-side; surface via lastResult.
                    });
                  }}
                >
                  <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="flex-1">{t('commandPalette.confirmSwitch', { name: pendingSwitchNode.name })}</span>
                </CommandItem>
                <CommandItem
                  value="test latency 测速"
                  disabled={leoapi.busyNodeId !== null}
                  onSelect={() => void leoapi.test(pendingSwitchNode)}
                >
                  <Gauge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.testNode', { name: pendingSwitchNode.name })}</span>
                </CommandItem>
                <CommandItem value="back cancel 返回" onSelect={() => setPendingSwitchNode(null)}>
                  <ChevronRight className="h-4 w-4 shrink-0 rotate-180 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.backToNodes')}</span>
                </CommandItem>
                {leoapi.lastResult && (
                  <div className="px-3 py-1.5 text-xs text-muted-foreground">{leoapi.lastResult}</div>
                )}
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading={t('commandPalette.navigate')}>
                {NAV_TABS.map((tab) => (
                  <CommandItem
                    key={tab.id as string}
                    value={`${t(tab.labelKey)} ${tab.keywords}`}
                    onSelect={() => run(() => onShowTab?.(tab.id))}
                  >
                    <span className="flex-1">{t(tab.labelKey)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showActions && projectId && (
              <CommandGroup heading={t('commandPalette.git')}>
                <CommandItem
                  value="Git Fetch remote"
                  onSelect={() => run(() => { void git.fetch(); onShowTab?.('git'); })}
                >
                  <RefreshCw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.fetch')}</span>
                </CommandItem>
                <CommandItem
                  value="Git Pull merge upstream"
                  onSelect={() => run(() => { void git.pull(); onShowTab?.('git'); })}
                >
                  <ArrowDownToLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.pull')}</span>
                </CommandItem>
                <CommandItem
                  value="Git Push origin remote"
                  onSelect={() => run(() => { void git.push(); onShowTab?.('git'); })}
                >
                  <ArrowUpFromLine className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('commandPalette.push')}</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading={t('commandPalette.settings')}>
                {SETTINGS_MAIN_TABS.map(({ id, label, keywords, icon: Icon }) => (
                  <CommandItem
                    key={id}
                    value={`${t('commandPalette.settings')} ${label} ${keywords}`}
                    onSelect={() => run(() => onOpenSettings(id))}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{t('commandPalette.settingItem', { label })}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showSessions && projectId && sessionsShown.length > 0 && (
              <CommandGroup
                heading={search.trim().length >= 2 && coveredProviders.length > 0
                  ? t('commandPalette.sessionsCovered', { providers: coveredProviders.join(' / ') })
                  : t('commandPalette.sessions')}
              >
                {sessionsShown.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${s.label} ${s.snippet ?? ''} ${s.id}`.trim()}
                    onSelect={() => run(() => navigate(`/session/${s.id}`))}
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{s.label}</span>
                      {s.snippet && (
                        <span className="truncate text-xs text-muted-foreground">{s.snippet}</span>
                      )}
                    </div>
                    {s.provider && (
                      <span className="text-xs text-muted-foreground">{s.provider}</span>
                    )}
                  </CommandItem>
                ))}
                {!page && sessionRows.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseSessions', { count: sessionRows.length })} onSelect={() => pushPage('sessions')} />
                )}
              </CommandGroup>
            )}

            {showFiles && projectId && filesShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.files')}>
                {filesShown.map((f) => (
                  <CommandItem
                    key={f.path}
                    value={f.path}
                    onSelect={() => run(() => ops.openFile(f.path))}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{f.path}</span>
                  </CommandItem>
                ))}
                {!page && files.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseFiles', { count: files.length })} onSelect={() => pushPage('files')} />
                )}
              </CommandGroup>
            )}

            {showCommits && projectId && commitsShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.commits')}>
                {commitsShown.map((c) => (
                  <CommandItem
                    key={c.hash}
                    value={`${c.message} ${c.author} ${c.shortHash}`}
                    onSelect={() => run(() => onShowTab?.('git'))}
                  >
                    <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-mono text-xs text-muted-foreground">{c.shortHash}</span>
                    <span className="flex-1 truncate">{c.message}</span>
                    <span className="truncate text-xs text-muted-foreground">{c.author}</span>
                  </CommandItem>
                ))}
                {!page && commits.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseCommits', { count: commits.length })} onSelect={() => pushPage('commits')} />
                )}
              </CommandGroup>
            )}

            {showBranches && projectId && branchesShown.length > 0 && (
              <CommandGroup heading={t('commandPalette.branches')}>
                {branchesShown.map((b) => (
                  <CommandItem
                    key={`branch-${b.name}`}
                    value={b.name}
                    onSelect={() => run(() => { void git.checkout(b.name); onShowTab?.('git'); })}
                  >
                    <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{t('commandPalette.switchBranch', { name: b.name })}</span>
                  </CommandItem>
                ))}
                {!page && branches.length > browseLimit && (
                  <BrowseAllItem label={t('commandPalette.browseBranches', { count: branches.length })} onSelect={() => pushPage('branches')} />
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function BrowseAllItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-muted-foreground">{label}</span>
    </CommandItem>
  );
}
