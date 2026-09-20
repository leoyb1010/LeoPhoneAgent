import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LEO_RELEASE_NOTES, currentAppVersion, currentReleaseNote, markWhatsNewSeen, shouldShowWhatsNew } from '../components/version-upgrade/releaseNotes';
import { useTheme } from '../contexts/ThemeContext';
import type { Project } from '../types/app';

import { api, type FleetOverview, type HarnessEvent, type LocalOverview, type ProviderInfo, type SessionSummary, type SessionTarget } from './api';
import { canOpenSessionPath, openSessionPath, openSessionTerm, openSessionUrl, pickSessionFolder, revealSessionPath, speakSessionText } from './desktop-folder';
import { dropBrowserFile, pasteSessionImage, pickSessionFiles } from './desktop-drop';
import { onSessionNoticeAction, onSessionNoticeClick, setDockNeedBadge, showSessionNotice } from './desktop-notice';
import { setSessionKeepAwake } from './desktop-awake';
import { onBatteryChanged, readBattery } from './desktop-battery';
import { onThermalChanged, readThermal } from './desktop-thermal';
import { desktopHotkeyTools, readGlobalHotkey, writeGlobalHotkey } from './desktop-hotkey';
import { onDisplayChanged } from './desktop-display';
import { onIdleBack } from './desktop-idle';
import { onLoadChanged, readLoad } from './desktop-load';
import { desktopLoginTools, readOpenAtLogin, writeOpenAtLogin } from './desktop-login';
import { onMemoryChanged, readMemory } from './desktop-memory';
import { onNetpathChanged } from './desktop-netpath';
import { onVolumeChanged } from './desktop-volume';
import { desktopFloatTools, readAlwaysOnTop, writeAlwaysOnTop } from './desktop-float';
import { desktopSpacesTools, readAllSpaces, writeAllSpaces } from './desktop-spaces';
import { desktopProtectTools, readContentProtection, writeContentProtection } from './desktop-protect';
import { desktopChimeTools, playSessionChime } from './desktop-chime';
import { desktopA11yTools, openDesktopAccessibility } from './desktop-a11y';
import { desktopAppsTools, moveDesktopToApplications, readAppFolder } from './desktop-apps';
import { desktopLogsTools, openDesktopLogs } from './desktop-applogs';
import { desktopRelaunchTools, relaunchDesktop } from './desktop-relaunch';
import { clearDesktopCache, desktopCacheTools } from './desktop-cache';
import { desktopCliTools, readCliInstall, writeCliInstall } from './desktop-cli';
import { readLastAbrupt } from './desktop-crash';
import { desktopEmojiTools, openDesktopEmoji } from './desktop-emoji';
import { desktopExtraTools, openDesktopExtraWindow } from './desktop-extra';
import { desktopLockTools, onAppLockChanged, readAppLock, writeAppLock } from './desktop-lock';
import { desktopUpdater, runDesktopUpdate } from './desktop-update';
import { onDockNew } from './desktop-dock';
import { onLeoScheme } from './desktop-scheme';
import { printSessionTalk } from './desktop-print';
import { canAcceptSessionDrop, mentionDroppedFile } from './session-drop';
import { canCommitSessionFiles, commitSessionFilesToast, defaultCommitMessage } from './session-commit';
import { canShowSessionDiff } from './session-diff';
import { canExportSession, exportFileName, exportSessionToast, flowRowsToMarkdown } from './session-export';
import { canShowEmoji, emojiLabel, emojiToast } from './session-emoji';
import { canOpenExtraWindow, extraWindowLabel, extraWindowToast } from './session-extra';
import { canRevertSessionFile, revertSessionFileToast } from './session-revert';
import { canRenameSession, clipSessionTitle, renameSessionToast } from './session-title';
import { canSetSessionRule, clipSessionRule, ruleSessionToast } from './session-rule';
import { canSetCwdRule, clipCwdRule, cwdRuleToast } from './session-cwd-rule';
import { saveCwdHabit } from './session-cwd-habit';
import { canMentionLastReply, lastAiReply, mentionLastReply, mentionLastReplyToast } from './session-reply';
import { canCopyLastReply, copyLastReplyToast } from './session-copy-reply';
import { canCopyTalk, copyTalkToast } from './session-copy-talk';
import { lastAbruptToast } from './session-crash';
import { canPrintTalk, clipPrintText, printTalkToast } from './session-print';
import { canHideSecrets, hideSecretsToast } from './session-hide';
import { canSetGlobalHotkey, globalHotkeyLabel, globalHotkeyToast } from './session-hotkey';
import { icloudCwdToast, isIcloudPath } from './session-icloud';
import { displayChangeToast } from './session-display';
import { idleBackToast } from './session-idle';
import { loadBusyToast, loadOkToast, loadSendToast } from './session-load';
import { canSetOpenAtLogin, openAtLoginLabel, openAtLoginToast } from './session-login';
import { memoryLowToast, memoryOkToast, memorySendToast } from './session-memory';
import { netpathChangeToast } from './session-netpath';
import { volumeChangeToast } from './session-volume';
import { alwaysOnTopLabel, alwaysOnTopToast, canSetAlwaysOnTop } from './session-float';
import { allSpacesLabel, allSpacesToast, canSetAllSpaces } from './session-spaces';
import { canSetContentProtection, contentProtectionLabel, contentProtectionToast } from './session-protect';
import { DONE_CHIME_KEY, canPlayDoneChime, chimesFromSnapshot, doneChimeLabel, doneChimeToast, readDoneChimeOn } from './session-chime';
import { canOpenAccessibility, openAccessibilityLabel, openAccessibilityToast } from './session-a11y';
import { canOpenLogs, openLogsLabel, openLogsToast } from './session-applogs';
import { canRelaunch, relaunchBusy, relaunchBusyToast, relaunchLabel, relaunchToast } from './session-relaunch';
import { canResumeThenSend, resumeThenSendLabel, resumeThenSendToast } from './session-resume-send';
import { canRewindLastTurn, rewindLastTurnLabel, rewindLastTurnToast } from './session-rewind';
import { canClearCache, clearCacheLabel, clearCacheToast } from './session-cache';
import { canInstallCli, installCliLabel, installCliToast } from './session-cli';
import { dockNewToast } from './session-dock';
import { canLockApp, lockLabel, lockToast } from './session-lock';
import { followSystemLabel, followSystemToast } from './session-theme';
import { canCheckUpdate, checkUpdateLabel, checkUpdateToast, nextUpdateAction, type UpdateRow } from './session-update';
import { leoSchemeToast, pickSchemeSession } from './session-scheme';
import { autoCompactToast, shouldAutoCompact } from './session-autocompact';
import { appendDictate, canDictate, clipDictateText, dictateListeningToast, dictateStoppedToast, dictateToast, dictateUnavailableToast, speechRecognitionCtor } from './session-dictate';
import { canSpeakLastReply, speakLastReplyToast } from './session-speak';
import { canRetryLastUser, lastUserPrompt, retryLastUserToast } from './session-retry';
import { canRetryAfterModelSwitch, retryAfterModelSwitchToast } from './session-switch-send';
import { canEditLastPrompt, editLastPromptDraft, editLastPromptToast } from './session-edit-prompt';
import { denySessionToast } from './session-deny';
import { canDenyAllHere, deniableApprovalIds, denyAllLabel, denyAllToast } from './session-deny-all';
import { canMentionLastTool, lastToolOutput, mentionLastTool, mentionLastToolToast } from './session-mention-tool';
import { canOpenLastWritten, lastWrittenFile, openLastWrittenToast } from './session-written';
import { canJumpLastFail, jumpLastFailToast, lastFailedRow } from './session-fail';
import { canQueueOnEnter } from './session-follow-enter';
import { canOpenLastRead, lastReadFile, openLastReadToast, readFileFromRow } from './session-read';
import { canForkSession, forkSeedText, forkSessionToast, forkTitle } from './session-fork';
import { canImportTalk, importSeedText, importTalkName, importTalkToast, importTitle } from './session-import-talk';
import { canShowSameCwd, sameCwdPickerHint, sameCwdSessions, sameCwdToast, type SameCwdSession } from './session-here';
import { canOpenTalkLinks, sessionTalkLinks, talkLinkPickerHint, talkLinkToast } from './session-links';
import { canShowSessionPulse, sessionPulseLabel, sessionPulseToast } from './session-pulse';
import { abortTurnLabel, abortTurnToast, canAbortTurn } from './session-abort';
import { applyPatchToast, canApplySessionPatch, clipApplyPatch } from './session-apply';
import { approveAllLabel, approveAllToast, canApproveAllHere, pendingApprovalIds } from './session-approve-all';
import { canMoveToApplications, moveToApplicationsBusy, moveToApplicationsBusyToast, moveToApplicationsLabel, moveToApplicationsToast } from './session-apps';
import { canSwitchSessionBranch, sanitizeBranchName, switchSessionBranchToast } from './session-branch';
import { canInitSessionRepo, initSessionToast } from './session-init';
import { canMergeSessionBranch, mergeSessionToast } from './session-merge';
import { isMissingSessionCwd, missingCwdToast } from './session-missing';
import { canPackSessionChanges, packFileName, packSessionToast } from './session-pack';
import { canFlushPeekOnSend, peekFlushedToast } from './session-peek-flush';
import { peekDraftToRestore, peekMemoryFile, peekMemoryKey, writePeekMemory, type PeekMemory } from './session-peek-memory';
import { lastFinishedEdit, peekReloadedToast, shouldReloadPeek } from './session-peek-sync';
import { canUnpackSessionZip, unpackSessionToast, unpackZipName } from './session-unpack';
import { canSeedSessionFile, clipSeedText, sanitizeSeedRel, seedSessionToast } from './session-seed';
import { canTrashSessionFile, trashSessionToast } from './session-trash';
import { canDuplicateSessionFile, duplicateSessionToast } from './session-duplicate';
import { canMkdirSessionFolder, mkdirSessionToast, sanitizeFolderRel } from './session-mkdir';
import { canMoveSessionFile, moveSessionToast, sanitizeMoveFolder } from './session-move';
import { DRAFTS_KEY, readPersistedDrafts, writePersistedDrafts } from './session-draft';
import { canHaltBusySessions, haltSessionsToast } from './session-halt';
import { shouldKeepAwake } from './session-awake';
import { batterySendToast, onAcToast, onBatteryToast } from './session-battery';
import { canStopSession, stopSessionToast, stoppableLocalSessions } from './session-stop';
import { canForgetEndedSessions, endedLocalSessionIds, forgetEndedToast } from './session-forget';
import { canRecallForgotten, recallSessionToast, type ForgottenSession } from './session-recall';
import { canPushSessionRepo, pushSessionToast } from './session-push';
import { canPullSessionRepo, pullSessionToast } from './session-pull';
import { canSearchSessionTalk, talkQueryReady } from './session-talk';
import { thermalCoolToast, thermalHotToast, thermalSendToast } from './session-thermal';
import { PINNED_SESSIONS_KEY, comparePinnedFirst, pinSessionToast, readPinnedSessionKeys, sessionIsPinned, togglePinnedSessionKey } from './session-pin';
import { canSearchSession, searchQueryReady, searchSessionToast, type SessionSearchHit } from './session-search';
import { canShowSessionLog, type SessionCommit } from './session-log';
import { approvalChoiceActions, approvalToast, dockNeedBadge, firstPendingApproval, noticeNotifyPayload, noticesFromSnapshot, sessionPathTarget } from './session-notice';
import { isBrowserOffline, offlineBanner, offlineToast, onlineToast } from './session-offline';
import { openIdleToast } from './session-open-idle';
import { HIDDEN_SESSIONS_KEY, POLICY_LABEL, STATUS_LABEL, THINKING_LABEL, THINKING_LEVELS, addHiddenSessionKey, removeHiddenSessionKey, applyEvent, boundWindowFromUnknown, clickPointFromElement, composerCanFollowUp, composerNeedsModelSwitch, composerPlaceholder, composerRunningHint, composerShouldFocus, composerShouldSend, composerShowsSteer, continueSessionDraft, countFilteredSessions, emptyView, endedComposerLead, endedSessionHint, flowFindActLabel, flowFindEmptyHint, flowFindHitKeys, flowFindHitText, flowFindStatus, flowRowMatchesQuery, followUpToast, formatContextWindow, hiddenHistoryHint, homeEmptyCopy, humanizeError, isHistoryStatus, isSameMachineName, keepActiveSession, lastLine, localCreateNeedsSettings, mentionWindowRead, mergeSameMachineSessions, modelChoiceHint, modelLikelyUnusable, nextFlowFindIndex, nextFocusIndex, nextProbeHealth, nextSessionIndex, nextUnseen, pendingFollowUps, prettyModelName, providerOf, queueClearedToast, rankModelsForPicker, readHiddenSessionKeys, relativeTime, scrollDeltaFromWheel, sessionCanDrive, sessionCanForget, sessionCanResume, sessionFailTexts, sessionKey, sessionMatchesFilter, sessionMatchesQuery, sessionNeedsSettings, settingsNeededCopy, shouldReconnectSessionStream, statusDotForSession, boundWindowChipKind, usableWindowMenus, windowBoundLabel, windowMenuLabel, windowPadGesture, WINDOW_KEY_BUTTONS, type FlowRow, type Group, type SessionView } from './model';
import { usableModelsFromProviders } from './settings-form';
import { artifactNameFromPath, clipFilePeek, cwdChipLabel, isPeekDrawer, isWorkspaceDrawer, machineChipLabel, peekCanWriteBack, peekFileCaption, sessionFilePath, titlebarHomeCopy } from './local-files';
import { REMOTE_DRAWER_ACTION_LABEL, isRemoteDrawerKind, mergeFilePins, remoteDrawerActions, remoteDrawerCopy } from './remote-drawer';
import { WhatsNewOverlay } from './WhatsNewOverlay';
import { ChannelsPage, DevicesPage, SettingsPage } from './pages';
import { NewSessionBox, Row, type ModelChoice } from './flow';
import './v2.css';

// 2.0 壳:主控(会话流水)· 设备 · 通道 · 设置 · ⌘K。
// 概念脊柱:每台机器上发生的事,是一条能在任何设备上续写的流水;需要你的地方是唯一发亮的点。

const Shell = lazy(() => import('../components/shell/view/Shell'));
const FileTree = lazy(() => import('../components/file-tree/view/FileTree'));
const BrowserUsePanel = lazy(() => import('../components/browser-use/view/BrowserUsePanel'));

type View = 'home' | 'devices' | 'channels' | 'settings';
type Filter = 'all' | 'active' | 'need' | 'err' | 'history';
type DrawerKind = 'term' | 'files' | 'diff' | 'browser' | null;
type NewBoxState = { open: boolean; machine: string; cwd?: string; prompt?: string; model?: string };
type Toast = { id: number; text: string; error: boolean };
type MenuItem = { v: string; t: string; sub?: string; dot?: string; dim?: boolean; sep?: boolean };
type MenuState = { x: number; y: number; items: MenuItem[]; onPick: (v: string) => void } | null;
type PickerKind = 'model' | 'policy' | 'think' | 'recall' | 'here' | 'link' | null;

const ORDER: Record<string, number> = { waiting_for_approval: 0, running: 1, starting: 1, failed: 2, idle: 3, completed: 4, cancelled: 4, orphaned: 5 };

function normalizeRemote(s: Partial<SessionSummary> & { session_id: string; status: string }): SessionSummary {
  return {
    session_id: s.session_id, harness: s.harness ?? 'pi', name: s.name ?? '', cwd: s.cwd ?? '', status: s.status,
    model: s.model ?? null, policy: s.policy ?? 'default', title: s.title ?? '', last_event: s.last_event ?? null,
    created_at: s.created_at ?? 0, updated_at: s.updated_at ?? 0, seq: s.seq ?? 0,
    waiting_for_approval: Boolean(s.waiting_for_approval), pending_approvals: s.pending_approvals ?? [],
  };
}

function useInterval(fn: () => void, ms: number): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** 会话事件流:先回放再跟随;断了按最后 seq 续传。 */
function useSessionStream(target: SessionTarget | null, seed: SessionSummary | null): { view: SessionView; stream: 'off' | 'live' | 'reconnecting' } {
  const [view, setView] = useState<SessionView>(() => emptyView(seed));
  const [stream, setStream] = useState<'off' | 'live' | 'reconnecting'>('off');
  const seqRef = useRef(0);
  const statusRef = useRef(seed?.status ?? '');
  useEffect(() => {
    seqRef.current = 0;
    statusRef.current = seed?.status ?? '';
    setView(emptyView(seed));
    setStream(target && shouldReconnectSessionStream(seed?.status) ? 'reconnecting' : 'off');
    if (!target) return undefined;
    let cancelled = false;
    let stop: (() => void) | null = null;
    let timer: number | null = null;
    const connect = () => {
      if (cancelled) return;
      stop = api.subscribe(target, seqRef.current, (event: HarnessEvent) => {
        if (typeof event.seq === 'number') seqRef.current = Math.max(seqRef.current, event.seq);
        setView((prev) => {
          const next = applyEvent(prev, event);
          statusRef.current = next.status;
          return next;
        });
      }, () => {
        if (cancelled) return;
        if (!shouldReconnectSessionStream(statusRef.current)) {
          setStream('off');
          return;
        }
        setStream('reconnecting');
        timer = window.setTimeout(connect, 1500);
      }, () => {
        if (!cancelled && shouldReconnectSessionStream(statusRef.current)) setStream('live');
      });
    };
    connect();
    return () => {
      cancelled = true;
      stop?.();
      if (timer) window.clearTimeout(timer);
    };
    // 终态 → 活着(接着这条)必须重连;同一条活着时 running/idle 不要重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.machine, target?.id, shouldReconnectSessionStream(seed?.status) ? 'live' : 'ended']);
  return { view, stream };
}

export default function App2() {
  const { isDarkMode, themeMode, setThemeMode, toggleDarkMode } = useTheme();
  const [view, setView] = useState<View>('home');
  const [filter, setFilter] = useState<Filter>('all');
  const [railQuery, setRailQuery] = useState('');
  const [talkIds, setTalkIds] = useState<string[]>([]);
  const [local, setLocal] = useState<LocalOverview | null>(null);
  const [fleet, setFleet] = useState<FleetOverview | null>(null);
  const [fleetHealth, setFleetHealth] = useState({ fails: 0, stale: false });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<SessionTarget | null>(() => {
    try { const raw = localStorage.getItem('leo2.active'); return raw ? (JSON.parse(raw) as SessionTarget) : null; } catch { return null; }
  });
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [workspace, setWorkspace] = useState<Project | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [focusFile, setFocusFile] = useState<string | null>(null);
  const [filePeek, setFilePeek] = useState<string | null>(null);
  const [filePeekDraft, setFilePeekDraft] = useState<string | null>(null);
  const [peekTick, setPeekTick] = useState(0);
  const [commitDraft, setCommitDraft] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const titleEditRef = useRef<HTMLInputElement | null>(null);
  const [ruleEditing, setRuleEditing] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<string | null>(null);
  const ruleEditRef = useRef<HTMLTextAreaElement | null>(null);
  const [cwdRuleEditing, setCwdRuleEditing] = useState(false);
  const [cwdRuleDraft, setCwdRuleDraft] = useState<string | null>(null);
  const cwdRuleEditRef = useRef<HTMLTextAreaElement | null>(null);
  const [sessionArtifacts, setSessionArtifacts] = useState<Array<{ name: string }>>([]);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState<ForgottenSession[]>([]);
  const [hereRows, setHereRows] = useState<SameCwdSession[]>([]);
  const [palette, setPalette] = useState<{ open: boolean; query: string; index: number }>({ open: false, query: '', index: 0 });
  const [hideSecretsOn, setHideSecretsOn] = useState(false);
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const canOpenAtLoginHere = canSetOpenAtLogin(desktopLoginTools());
  const [globalHotkey, setGlobalHotkey] = useState(false);
  const canHotkeyHere = canSetGlobalHotkey(desktopHotkeyTools());
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const canAlwaysOnTopHere = canSetAlwaysOnTop(desktopFloatTools());
  const [allSpaces, setAllSpaces] = useState(false);
  const canAllSpacesHere = canSetAllSpaces(desktopSpacesTools());
  const [contentProtection, setContentProtection] = useState(false);
  const canProtectHere = canSetContentProtection(desktopProtectTools());
  const [doneChimeOn, setDoneChimeOn] = useState(() => {
    try { return readDoneChimeOn(localStorage.getItem(DONE_CHIME_KEY)); } catch { return true; }
  });
  const canDoneChimeHere = canPlayDoneChime(desktopChimeTools());
  const canOpenLogsHere = canOpenLogs(desktopLogsTools());
  const canOpenA11yHere = canOpenAccessibility(desktopA11yTools());
  const canRelaunchHere = canRelaunch(desktopRelaunchTools());
  const canExtraHere = canOpenExtraWindow(desktopExtraTools());
  const canEmojiHere = canShowEmoji(desktopEmojiTools());
  const canClearCacheHere = canClearCache(desktopCacheTools());
  const canLockHere = canLockApp(desktopLockTools());
  const [appLocked, setAppLocked] = useState(false);
  const canCliHere = canInstallCli(desktopCliTools());
  const [cliInstalled, setCliInstalled] = useState(false);
  const canAppsHere = canMoveToApplications(desktopAppsTools());
  const [inApplications, setInApplications] = useState(false);
  const [netOffline, setNetOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const [onBattery, setOnBattery] = useState(false);
  const batterySendWarned = useRef(false);
  const [thermalHot, setThermalHot] = useState(false);
  const thermalSendWarned = useRef(false);
  const [memoryLow, setMemoryLow] = useState(false);
  const memorySendWarned = useRef(false);
  const [loadBusy, setLoadBusy] = useState(false);
  const loadSendWarned = useRef(false);
  const canCheckUpdateHere = canCheckUpdate(desktopUpdater());
  const [updateState, setUpdateState] = useState<UpdateRow | null>(null);
  const chimePrev = useRef<Map<string, string>>(new Map());
  const chimePrimed = useRef(false);
  const compactPrev = useRef<Map<string, string>>(new Map());
  const compactPrimed = useRef(false);
  const autoCompacted = useRef(new Set<string>());
  const peekSyncSession = useRef('');
  const peekSyncSeen = useRef('');
  const peekMem = useRef(new Map<string, PeekMemory>());
  const peekMemSession = useRef('');
  const peekRestore = useRef<{ file: string; draft: string } | null>(null);
  const peekLive = useRef({ file: null as string | null, peek: null as string | null, draft: null as string | null });
  peekLive.current = { file: focusFile, peek: filePeek, draft: filePeekDraft };
  const icloudWarned = useRef(new Set<string>());
  const missingWarned = useRef(new Set<string>());
  const [menu, setMenu] = useState<MenuState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [newBox, setNewBox] = useState<NewBoxState | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try { return readPersistedDrafts(localStorage.getItem(DRAFTS_KEY)); } catch { return {}; }
  });
  const draftKey = active ? `${active.machine}:${active.id}` : '';
  const draft = draftKey ? (drafts[draftKey] ?? '') : '';
  const setDraft = useCallback((text: string) => {
    if (!draftKey) return;
    setDrafts((d) => (d[draftKey] === text ? d : { ...d, [draftKey]: text }));
  }, [draftKey]);
  useEffect(() => {
    try { localStorage.setItem(DRAFTS_KEY, writePersistedDrafts(drafts)); } catch { /* ignore */ }
  }, [drafts]);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ kind: Exclude<PickerKind, null>; query: string; index: number } | null>(null);
  const [openLegacy, setOpenLegacy] = useState(false);
  const [focusMachine, setFocusMachine] = useState<string | null>(null);
  const [whatsNew, setWhatsNew] = useState<ReturnType<typeof currentReleaseNote>>(null);
  const [flowFind, setFlowFind] = useState({ open: false, query: '', index: 0 });
  const [failFocusKey, setFailFocusKey] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);
  const dictateRef = useRef<{ stop: () => void } | null>(null);
  useEffect(() => () => {
    try { dictateRef.current?.stop(); } catch { /* leaving */ }
  }, []);
  const [windowOp, setWindowOp] = useState<{ label: string; draft: string; windows: Array<{ snapshotId: string; app: string; title: string; frontmost: boolean }>; peek: string | null; menus: Array<{ path: string[] }> } | null>(null);
  const [hiddenKeys, setHiddenKeys] = useState<string[]>(() => {
    try { return readHiddenSessionKeys(localStorage.getItem(HIDDEN_SESSIONS_KEY)); } catch { return []; }
  });
  const hiddenSet = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);
  const [pinnedKeys, setPinnedKeys] = useState<string[]>(() => {
    try { return readPinnedSessionKeys(localStorage.getItem(PINNED_SESSIONS_KEY)); } catch { return []; }
  });
  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys]);
  const [wsQuery, setWsQuery] = useState('');
  const [seedName, setSeedName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [moveDest, setMoveDest] = useState('');
  const [wsHits, setWsHits] = useState<SessionSearchHit[]>([]);
  const [wsTruncated, setWsTruncated] = useState(false);
  const wsSearchRef = useRef<HTMLInputElement | null>(null);
  const [commits, setCommits] = useState<SessionCommit[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const [focusCommit, setFocusCommit] = useState<string | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const railListRef = useRef<HTMLDivElement | null>(null);
  const drawerCloseRef = useRef<HTMLButtonElement | null>(null);
  const flowFindRef = useRef<HTMLInputElement | null>(null);
  const winHitRef = useRef<{ x: number; y: number } | null>(null);

  const toast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 4000 : 2200);
  }, []);
  useEffect(() => {
    const goOff = () => {
      setNetOffline(true);
      toast(offlineToast(), true);
    };
    const goOn = () => {
      setNetOffline(false);
      toast(onlineToast());
    };
    window.addEventListener('offline', goOff);
    window.addEventListener('online', goOn);
    return () => {
      window.removeEventListener('offline', goOff);
      window.removeEventListener('online', goOn);
    };
  }, [toast]);
  useEffect(() => {
    void readLastAbrupt().then((hit) => {
      if (hit) toast(lastAbruptToast(), true);
    });
  }, [toast]);
  useEffect(() => {
    void readBattery().then(setOnBattery);
    return onBatteryChanged((on) => {
      setOnBattery((prev) => {
        if (prev !== on) toast(on ? onBatteryToast() : onAcToast(), on);
        if (!on) batterySendWarned.current = false;
        return on;
      });
    });
  }, [toast]);
  const warnBatterySend = useCallback(() => {
    if (!onBattery || batterySendWarned.current) return;
    batterySendWarned.current = true;
    toast(batterySendToast());
  }, [onBattery, toast]);
  useEffect(() => {
    void readThermal().then((row) => setThermalHot(Boolean(row.hot)));
    return onThermalChanged((row) => {
      const next = Boolean(row.hot);
      setThermalHot((prev) => {
        if (prev !== next) toast(next ? thermalHotToast(row.state) : thermalCoolToast(), next);
        if (!next) thermalSendWarned.current = false;
        return next;
      });
    });
  }, [toast]);
  const warnThermalSend = useCallback(() => {
    if (!thermalHot || thermalSendWarned.current) return;
    thermalSendWarned.current = true;
    toast(thermalSendToast());
  }, [thermalHot, toast]);
  useEffect(() => onIdleBack(() => toast(idleBackToast())), [toast]);
  useEffect(() => onDisplayChanged((row) => toast(displayChangeToast(row.kind))), [toast]);
  useEffect(() => onVolumeChanged((row) => toast(volumeChangeToast(row.kind))), [toast]);
  useEffect(() => onNetpathChanged(() => toast(netpathChangeToast())), [toast]);
  useEffect(() => {
    void readMemory().then(setMemoryLow);
    return onMemoryChanged((low) => {
      setMemoryLow((prev) => {
        if (prev !== low) toast(low ? memoryLowToast() : memoryOkToast(), low);
        if (!low) memorySendWarned.current = false;
        return low;
      });
    });
  }, [toast]);
  const warnMemorySend = useCallback(() => {
    if (!memoryLow || memorySendWarned.current) return;
    memorySendWarned.current = true;
    toast(memorySendToast());
  }, [memoryLow, toast]);
  useEffect(() => {
    void readLoad().then(setLoadBusy);
    return onLoadChanged((busy) => {
      setLoadBusy((prev) => {
        if (prev !== busy) toast(busy ? loadBusyToast() : loadOkToast(), busy);
        if (!busy) loadSendWarned.current = false;
        return busy;
      });
    });
  }, [toast]);
  const warnLoadSend = useCallback(() => {
    if (!loadBusy || loadSendWarned.current) return;
    loadSendWarned.current = true;
    toast(loadSendToast());
  }, [loadBusy, toast]);
  const warnIcloud = useCallback((cwd?: string | null) => {
    const path = String(cwd ?? '').trim();
    if (!isIcloudPath(path) || icloudWarned.current.has(path)) return;
    icloudWarned.current.add(path);
    toast(icloudCwdToast());
  }, [toast]);
  const warnMissing = useCallback(async (cwd?: string | null) => {
    const path = String(cwd ?? '').trim();
    if (!path || missingWarned.current.has(path)) return false;
    const gone = await isMissingSessionCwd(path, typeof window === 'undefined' ? null : window.leocodeboxDesktopTools);
    if (!gone) return false;
    missingWarned.current.add(path);
    toast(missingCwdToast(), true);
    return true;
  }, [toast]);

  // -- 数据 ------------------------------------------------------------------
  const refreshLocal = useCallback(async () => {
    try { setLocal(await api.local()); setLoadError(null); } catch (e) { setLoadError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const refreshFleet = useCallback(async () => {
    try {
      setFleet(await api.fleet());
      setFleetHealth((prev) => nextProbeHealth(prev.fails, true));
    } catch {
      setFleetHealth((prev) => nextProbeHealth(prev.fails, false));
    }
  }, []);
  const refreshProviders = useCallback(async () => {
    try { setProviders((await api.providers()).providers); } catch { setProviders((prev) => prev ?? []); }
  }, []);
  useEffect(() => { void refreshLocal(); void refreshFleet(); void refreshProviders(); }, [refreshLocal, refreshFleet, refreshProviders]);
  const appVersion = currentAppVersion();
  useEffect(() => { if (shouldShowWhatsNew()) setWhatsNew(currentReleaseNote()); }, [appVersion]);
  useInterval(() => { void refreshLocal(); }, 4000);
  useInterval(() => { void refreshFleet(); }, 12000);
  useEffect(() => { try { localStorage.setItem('leo2.active', JSON.stringify(active)); } catch { /* ignore */ } }, [active]);

  const groups = useMemo<Group[]>(() => {
    const extras: SessionSummary[] = [];
    const remotes: Group[] = [];
    for (const m of fleet?.machines ?? []) {
      if (local && (isSameMachineName(m.name, local.name) || isSameMachineName(m.name, fleet?.localName))) {
        extras.push(...m.sessions.map(normalizeRemote));
        continue;
      }
      remotes.push({ id: m.name, name: m.name, role: '被控', online: m.online && m.reachable, stale: fleetHealth.stale, sessions: m.sessions.map(normalizeRemote) });
    }
    const out: Group[] = [];
    if (local) out.push({ id: 'local', name: local.name, role: '本机', online: true, sessions: mergeSameMachineSessions(local.sessions, extras) });
    out.push(...remotes);
    return out;
  }, [local, fleet, fleetHealth.stale]);

  const allSessions = useMemo(() => groups.flatMap((g) => g.sessions.map((s) => ({ machine: g.id, machineName: g.name, s }))).filter((x) => !hiddenSet.has(sessionKey(x.machine, x.s.session_id))), [groups, hiddenSet]);
  const activeEntry = useMemo(() => allSessions.find((x) => active && x.machine === active.machine && x.s.session_id === active.id) ?? null, [allSessions, active]);
  const activeSummary = activeEntry?.s ?? null;
  const { view: sessionView, stream } = useSessionStream(active, activeSummary);
  const canDrive = Boolean(activeSummary && sessionCanDrive(activeSummary.status, sessionView.status));
  const canFollowUp = Boolean(active && composerCanFollowUp(active.machine, sessionView.status));
  const queuedFollowUps = pendingFollowUps(sessionView.rows);
  useEffect(() => { setCommitDraft(null); setTitleEditing(false); setTitleDraft(null); setRuleEditing(false); setRuleDraft(null); setSeedName(''); }, [active?.machine, active?.id]);
  const pinFiles = useMemo(
    () => mergeFilePins(
      sessionView.rows.filter((row): row is FlowRow & { k: 'edit' } => row.k === 'edit'),
      sessionArtifacts,
    ).map((row) => row.file),
    [sessionArtifacts, sessionView.rows],
  );
  const canCommitHere = canCommitSessionFiles(active?.machine, pinFiles);
  const canExportHere = canExportSession(active?.machine, sessionView.rows);
  const canCopyTalkHere = canCopyTalk(active?.machine, sessionView.rows);
  const canPrintTalkHere = canPrintTalk(active?.machine, sessionView.rows);
  const canHideHere = canHideSecrets(active?.machine, sessionView.rows);
  const canDictateHere = canDictate(active?.machine);
  const canSearchHere = canSearchSession(active?.machine);
  const lastReply = lastAiReply(sessionView.rows);
  const canMentionLast = canMentionLastReply(sessionView.rows);
  const canCopyLast = canCopyLastReply(sessionView.rows);
  const canSpeakLast = canSpeakLastReply(active?.machine, sessionView.rows);
  const lastPrompt = lastUserPrompt(sessionView.rows);
  const canRetryLast = canRetryLastUser({ canDrive, running: composerShowsSteer(sessionView.status), rows: sessionView.rows });
  const canEditLast = canEditLastPrompt(sessionView.rows);
  const canRewindHere = canRewindLastTurn({ machine: active?.machine, status: sessionView.status, rows: sessionView.rows });
  const lastTool = lastToolOutput(sessionView.rows);
  const canMentionTool = canMentionLastTool(sessionView.rows);
  const lastWritten = lastWrittenFile(sessionView.rows);
  const canOpenWritten = canOpenLastWritten(active?.machine, sessionView.rows);
  const lastFail = lastFailedRow(sessionView.rows);
  const canJumpFail = canJumpLastFail(active?.machine, sessionView.rows);
  const lastRead = lastReadFile(sessionView.rows);
  const canOpenRead = canOpenLastRead(active?.machine, sessionView.rows);
  const herePeers = useMemo(
    () => sameCwdSessions(allSessions, activeSummary?.cwd, active?.id),
    [allSessions, activeSummary?.cwd, active?.id],
  );
  const canHere = canShowSameCwd(active?.machine, herePeers);
  const pulseLabel = sessionPulseLabel({ rows: sessionView.rows, createdAt: activeSummary?.created_at });
  const canPulse = canShowSessionPulse(active?.machine, sessionView.rows, activeSummary?.created_at);
  const canFork = canForkSession(active?.machine, activeSummary?.cwd, sessionView.rows);
  const canImportHere = canImportTalk(active?.machine, activeSummary?.cwd);
  const talkLinks = useMemo(() => sessionTalkLinks(sessionView.rows), [sessionView.rows]);
  const canLinks = canOpenTalkLinks(active?.machine, talkLinks);
  const canApplyHere = canApplySessionPatch(active?.machine);
  const canAbortTurnHere = canAbortTurn(active?.machine, sessionView.status);
  const pendingIds = useMemo(() => pendingApprovalIds(sessionView.pendingApprovals.values()), [sessionView.pendingApprovals]);
  const denyIds = useMemo(() => deniableApprovalIds(sessionView.pendingApprovals.values()), [sessionView.pendingApprovals]);
  const canApproveAll = canApproveAllHere(active?.machine, pendingIds);
  const canDenyAll = canDenyAllHere(active?.machine, denyIds);
  const canPackHere = canPackSessionChanges(active?.machine);
  const canUnpackHere = canUnpackSessionZip(active?.machine);
  const canSeedHere = canSeedSessionFile(active?.machine);
  const canTrashHere = canTrashSessionFile(active?.machine, focusFile);
  const canDuplicateHere = canDuplicateSessionFile(active?.machine, focusFile);
  const canMkdirHere = canMkdirSessionFolder(active?.machine);
  const canBranchHere = canSwitchSessionBranch(active?.machine);
  const canInitHere = canInitSessionRepo(active?.machine);
  const canMergeHere = canMergeSessionBranch(active?.machine);
  const canMoveHere = canMoveSessionFile(active?.machine, focusFile);
  const canHaltBusy = canHaltBusySessions(allSessions);
  const canForgetEnded = canForgetEndedSessions(allSessions, pinnedKeys);
  const canRecallHere = canRecallForgotten('local');
  const canCwdRuleHere = canSetCwdRule(active?.machine);
  const canPushHere = canPushSessionRepo(active?.machine);
  const canPullHere = canPullSessionRepo(active?.machine);
  const findHits = useMemo(() => flowFindHitKeys(sessionView.rows, flowFind.query), [sessionView.rows, flowFind.query]);
  const findIndex = findHits.length ? Math.min(Math.max(flowFind.index, 0), findHits.length - 1) : -1;
  const findKey = findIndex >= 0 ? findHits[findIndex] : null;
  const stepFind = useCallback((dir: 1 | -1) => {
    setFlowFind((cur) => {
      const keys = flowFindHitKeys(sessionView.rows, cur.query);
      return { ...cur, open: true, index: nextFlowFindIndex(keys.length, cur.index, dir) };
    });
  }, [sessionView.rows]);
  useEffect(() => {
    if (!flowFind.open || !findKey) return;
    const el = document.querySelector(`[data-flow-key="${CSS.escape(findKey)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [findKey, flowFind.open]);
  useEffect(() => {
    if (!failFocusKey) return;
    const el = document.querySelector(`[data-flow-key="${CSS.escape(failFocusKey)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failFocusKey]);
  useEffect(() => {
    setFlowFind({ open: false, query: '', index: 0 });
  }, [active?.machine, active?.id]);

  const counts = useMemo(() => {
    const rows = allSessions.map((x) => x.s);
    const activeId = active?.id;
    return {
      all: countFilteredSessions(rows, 'all', activeId),
      active: countFilteredSessions(rows, 'active', activeId),
      need: countFilteredSessions(rows, 'need', activeId),
      err: countFilteredSessions(rows, 'err', activeId),
      history: countFilteredSessions(rows, 'history', activeId),
    };
  }, [allSessions, active?.id]);

  const matchesFilter = useCallback((s: SessionSummary) => sessionMatchesFilter(s, filter), [filter]);

  const othersNeedingYou = useMemo(() => allSessions.filter((x) => x.s.status === 'waiting_for_approval' && !(active && x.machine === active.machine && x.s.session_id === active.id)), [allSessions, active]);
  const noticePrev = useRef<Map<string, string>>(new Map());
  const noticePrimed = useRef(false);

  useEffect(() => {
    const fromPath = sessionPathTarget(window.location.pathname);
    if (fromPath) {
      setActive(fromPath);
      setView('home');
    }
  }, []);

  useEffect(() => onSessionNoticeClick((target) => {
    setActive(target);
    setView('home');
  }), []);
  const schemeSessions = useRef(allSessions);
  schemeSessions.current = allSessions;
  useEffect(() => onLeoScheme((cwd) => {
    const hit = pickSchemeSession(schemeSessions.current, cwd);
    if (hit) {
      setActive({ machine: 'local', id: hit.session_id });
      setView('home');
      toast(leoSchemeToast(hit.title));
      warnIcloud(cwd);
      void warnMissing(cwd);
      return;
    }
    setNewBox({ open: true, machine: 'local', cwd });
    setView('home');
    toast(leoSchemeToast());
    warnIcloud(cwd);
    void warnMissing(cwd);
  }), [toast, warnIcloud, warnMissing]);

  useEffect(() => {
    if (active?.machine !== 'local') return;
    warnIcloud(activeSummary?.cwd);
    void warnMissing(activeSummary?.cwd);
  }, [active?.machine, activeSummary?.cwd, warnIcloud, warnMissing]);
  useEffect(() => {
    void setDockNeedBadge(dockNeedBadge(allSessions.map((row) => row.s)));
  }, [allSessions]);
  useEffect(() => {
    void setSessionKeepAwake(shouldKeepAwake(allSessions));
  }, [allSessions]);
  useEffect(() => {
    if (!canOpenAtLoginHere) return;
    void readOpenAtLogin().then(setOpenAtLogin).catch(() => setOpenAtLogin(false));
  }, [canOpenAtLoginHere]);
  useEffect(() => {
    if (!canHotkeyHere) return;
    void readGlobalHotkey().then(setGlobalHotkey).catch(() => setGlobalHotkey(false));
  }, [canHotkeyHere]);
  useEffect(() => {
    if (!canAlwaysOnTopHere) return;
    void readAlwaysOnTop().then(setAlwaysOnTop).catch(() => setAlwaysOnTop(false));
  }, [canAlwaysOnTopHere]);
  useEffect(() => {
    if (!canAllSpacesHere) return;
    void readAllSpaces().then(setAllSpaces).catch(() => setAllSpaces(false));
  }, [canAllSpacesHere]);
  useEffect(() => {
    if (!canProtectHere) return;
    void readContentProtection().then(setContentProtection).catch(() => setContentProtection(false));
  }, [canProtectHere]);
  useEffect(() => {
    if (!canLockHere) return undefined;
    void readAppLock().then(setAppLocked).catch(() => setAppLocked(false));
    return onAppLockChanged(setAppLocked);
  }, [canLockHere]);
  useEffect(() => {
    if (!canCliHere) return;
    void readCliInstall().then(setCliInstalled).catch(() => setCliInstalled(false));
  }, [canCliHere]);
  useEffect(() => {
    if (!canAppsHere) return;
    void readAppFolder().then(setInApplications).catch(() => setInApplications(false));
  }, [canAppsHere]);
  useEffect(() => {
    if (!canCheckUpdateHere) return undefined;
    const bridge = desktopUpdater();
    void bridge?.getState?.().then(setUpdateState).catch(() => setUpdateState(null));
    return bridge?.onStateChanged?.((row) => setUpdateState(row));
  }, [canCheckUpdateHere]);

  useEffect(() => {
    const next = allSessions.map((row) => {
      const pending = firstPendingApproval(row.s);
      return {
        key: sessionKey(row.machine, row.s.session_id),
        machine: row.machine,
        id: row.s.session_id,
        status: row.s.status,
        title: row.s.title || '新会话',
        command: pending?.command ?? row.s.last_event?.text ?? '',
        approvalId: pending?.approvalId,
        choices: pending?.choices,
      };
    });
    const { notices, map } = noticesFromSnapshot({
      primed: noticePrimed.current,
      prev: noticePrev.current,
      next,
      activeKey: active ? sessionKey(active.machine, active.id) : null,
      windowFocused: document.hasFocus() && !document.hidden,
    });
    noticePrev.current = map;
    noticePrimed.current = true;
    for (const notice of notices) {
      void showSessionNotice(noticeNotifyPayload(notice));
    }
    const chime = chimesFromSnapshot({
      primed: chimePrimed.current,
      prev: chimePrev.current,
      next: next.map((row) => ({ key: row.key, machine: row.machine, status: row.status })),
    });
    chimePrev.current = chime.map;
    chimePrimed.current = true;
    if (doneChimeOn && canDoneChimeHere && chime.count > 0) {
      void playSessionChime().catch(() => undefined);
    }
  }, [allSessions, active, doneChimeOn, canDoneChimeHere]);
  useEffect(() => {
    for (const row of allSessions) {
      const key = sessionKey(row.machine, row.s.session_id);
      if (
        shouldAutoCompact({
          primed: compactPrimed.current,
          machine: row.machine,
          prevStatus: compactPrev.current.get(key),
          nextStatus: row.s.status,
          errorText: row.s.last_event?.text ?? lastLine(row.s),
        }) && !autoCompacted.current.has(key)
      ) {
        autoCompacted.current.add(key);
        void api.rpc({ machine: row.machine, id: row.s.session_id }, { type: 'compact' })
          .then(() => toast(autoCompactToast()))
          .catch(() => undefined);
      }
    }
    compactPrev.current = new Map(allSessions.map((row) => [sessionKey(row.machine, row.s.session_id), row.s.status]));
    compactPrimed.current = true;
  }, [allSessions, toast]);

  // 首次进来没有选中会话:挑一条最需要看的。
  useEffect(() => {
    if (active || allSessions.length === 0) return;
    const pick = [...allSessions].sort((a, b) => (ORDER[a.s.status] ?? 9) - (ORDER[b.s.status] ?? 9) || b.s.updated_at - a.s.updated_at)[0];
    if (pick) setActive({ machine: pick.machine, id: pick.s.session_id });
  }, [active, allSessions]);
  useEffect(() => {
    if (!talkQueryReady(railQuery) || !canSearchSessionTalk('local')) {
      setTalkIds([]);
      return undefined;
    }
    const q = railQuery.trim();
    const timer = window.setTimeout(() => {
      void api.searchLocalTalk(q).then((result) => {
        if (q === railQuery.trim()) setTalkIds(result.hits.map((hit) => hit.session_id));
      }).catch(() => {
        if (q === railQuery.trim()) setTalkIds([]);
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [railQuery]);

  useEffect(() => {
    if (!isWorkspaceDrawer(drawer) || !active || active.machine !== 'local') {
      if (!isWorkspaceDrawer(drawer)) {
        setWorkspace(null);
        setWorkspaceError(null);
      }
      return;
    }
    const nextCwd = activeSummary?.cwd?.trim();
    if (!nextCwd) {
      setWorkspace(null);
      setWorkspaceError('这条会话没有目录');
      return;
    }
    let cancelled = false;
    setWorkspace(null);
    setWorkspaceError(null);
    void api.ensureWorkspace(nextCwd).then((row) => {
      if (cancelled) return;
      setWorkspace({
        projectId: row.projectId,
        displayName: row.displayName,
        fullPath: row.fullPath,
        path: row.path,
      });
    }).catch((error) => {
      if (cancelled) return;
      setWorkspaceError(humanizeError(error instanceof Error ? error.message : String(error)));
    });
    return () => { cancelled = true; };
  }, [drawer, active, activeSummary?.cwd]);

  useEffect(() => {
    if (!isPeekDrawer(drawer)) {
      writePeekMemory(peekMem.current, peekMemSession.current, peekLive.current);
      setFocusFile(null);
      setFilePeek(null);
      setFilePeekDraft(null);
      setSessionArtifacts([]);
      setArtifactError(null);
      return;
    }
    const mem = peekMem.current.get(peekMemSession.current);
    const file = peekMemoryFile(mem);
    if (!file) return;
    const draft = peekDraftToRestore(mem, file);
    peekRestore.current = draft != null ? { file, draft } : null;
    setFocusFile(file);
  }, [drawer]);

  useEffect(() => {
    const key = peekMemoryKey(active?.machine, active?.id);
    if (peekMemSession.current === key) return;
    writePeekMemory(peekMem.current, peekMemSession.current, peekLive.current);
    peekMemSession.current = key;
    if (!isPeekDrawer(drawer)) {
      setFocusFile(null);
      setFilePeek(null);
      setFilePeekDraft(null);
      return;
    }
    const mem = key ? peekMem.current.get(key) : undefined;
    const file = peekMemoryFile(mem);
    const draft = peekDraftToRestore(mem, file);
    peekRestore.current = file && draft != null ? { file, draft } : null;
    setFocusCommit(null);
    setFocusFile(file);
    if (!file) {
      setFilePeek(null);
      setFilePeekDraft(null);
    }
  }, [active?.id, active?.machine, drawer]);

  useEffect(() => {
    if (!isPeekDrawer(drawer) || !active) {
      setSessionArtifacts([]);
      setArtifactError(null);
      return;
    }
    let cancelled = false;
    setArtifactError(null);
    void api.listArtifacts(active).then((row) => {
      if (!cancelled) setSessionArtifacts(row.artifacts ?? []);
    }).catch((error) => {
      if (!cancelled) {
        setSessionArtifacts([]);
        setArtifactError(humanizeError(error instanceof Error ? error.message : String(error)));
      }
    });
    return () => { cancelled = true; };
  }, [drawer, active]);

  useEffect(() => {
    if (!isPeekDrawer(drawer) || !active || (!focusFile && !focusCommit)) {
      if (!focusFile && !focusCommit) {
        setFilePeek(null);
        setFilePeekDraft(null);
      }
      return;
    }
    const cwd = activeSummary?.cwd ?? workspace?.fullPath ?? '';
    const localPath = focusFile ? sessionFilePath(cwd, focusFile) : '';
    const artifactName = focusFile ? artifactNameFromPath(cwd, focusFile) : '';
    if (!focusCommit && !localPath && !artifactName) return;
    let cancelled = false;
    setFilePeek('正在读…');
    setFilePeekDraft('正在读…');
    const load = async (): Promise<string> => {
      if (drawer === 'diff' && focusCommit && canShowSessionLog(active.machine)) {
        const row = await api.showLocalCommit(active, focusCommit);
        return clipFilePeek(row.patch);
      }
      if (drawer === 'diff' && focusFile && canShowSessionDiff(active.machine, focusFile)) {
        const row = await api.diffLocalFile(active, focusFile);
        return clipFilePeek(row.patch);
      }
      if (active.machine === 'local' && workspace?.projectId && localPath) {
        try {
          const row = await api.readProjectFile(workspace.projectId, localPath);
          return clipFilePeek(row.content ?? '');
        } catch {
          // 项目树读不到时再走会话产物。
        }
      }
      if (!artifactName) throw new Error('没有文件名');
      const row = await api.readSessionArtifact(active, artifactName);
      return clipFilePeek(row.content ?? '');
    };
    void load().then((text) => {
      if (cancelled) return;
      setFilePeek(text);
      const restore = !focusCommit ? peekRestore.current : null;
      if (restore && restore.file === String(focusFile ?? '').trim()) {
        setFilePeekDraft(restore.draft);
        peekRestore.current = null;
      } else {
        setFilePeekDraft(text);
      }
    }).catch((error) => {
      if (cancelled) return;
      const text = `读不了:${humanizeError(error instanceof Error ? error.message : String(error))}`;
      setFilePeek(text);
      const restore = !focusCommit ? peekRestore.current : null;
      if (restore && restore.file === String(focusFile ?? '').trim()) {
        setFilePeekDraft(restore.draft);
        peekRestore.current = null;
      } else {
        setFilePeekDraft(text);
      }
    });
    return () => { cancelled = true; };
  }, [drawer, active, workspace?.projectId, workspace?.fullPath, focusFile, focusCommit, activeSummary?.cwd, peekTick]);

  const finishedEdit = lastFinishedEdit(sessionView.rows);
  useEffect(() => {
    const sessionKey = active ? `${active.machine}:${active.id}` : '';
    if (peekSyncSession.current !== sessionKey) {
      peekSyncSession.current = sessionKey;
      peekSyncSeen.current = finishedEdit?.key ?? '';
      return;
    }
    const seen = finishedEdit?.key ?? '';
    if (peekSyncSeen.current === seen) return;
    const dirty = filePeekDraft != null && filePeekDraft !== filePeek;
    if (!shouldReloadPeek({ machine: active?.machine, focusFile, dirty, written: finishedEdit?.file })) {
      peekSyncSeen.current = seen;
      return;
    }
    peekSyncSeen.current = seen;
    setPeekTick((tick) => tick + 1);
    toast(peekReloadedToast(finishedEdit?.file));
  }, [active, finishedEdit?.file, finishedEdit?.key, focusFile, filePeek, filePeekDraft, toast]);

  useEffect(() => {
    if (drawer !== 'diff' || !active || !canShowSessionLog(active.machine)) {
      if (drawer !== 'diff') { setCommits([]); setLogError(null); setFocusCommit(null); }
      return;
    }
    let cancelled = false;
    void api.listLocalCommits(active).then((row) => {
      if (cancelled) return;
      setCommits(row.commits ?? []);
      setLogError(null);
    }).catch((error) => {
      if (cancelled) return;
      setCommits([]);
      setLogError(humanizeError(error instanceof Error ? error.message : String(error)));
    });
    return () => { cancelled = true; };
  }, [drawer, active, peekTick]);

  useEffect(() => {
    if (!isPeekDrawer(drawer) || focusFile || focusCommit) return;
    const first = mergeFilePins(
      sessionView.rows.filter((row): row is FlowRow & { k: 'edit' } => row.k === 'edit'),
      sessionArtifacts,
    )[0];
    if (first?.file) setFocusFile(first.file);
  }, [drawer, focusFile, focusCommit, sessionView.rows, sessionArtifacts]);

  // 头与输入区是悬浮玻璃,流水的内边距跟着它们的实际高度走。
  const layoutFlow = useCallback(() => {
    const flow = flowRef.current; if (!flow) return;
    flow.style.paddingTop = `${(headRef.current?.offsetHeight ?? 56) + 16}px`;
    flow.style.paddingBottom = `${(composerRef.current?.offsetHeight ?? 90) + 8}px`;
  }, []);
  useEffect(() => { layoutFlow(); window.addEventListener('resize', layoutFlow); return () => window.removeEventListener('resize', layoutFlow); }, [layoutFlow, view, othersNeedingYou.length, sessionView.rows.length, canDrive, flowFind.open]);
  useEffect(() => { if (drawer) drawerCloseRef.current?.focus(); }, [drawer]);
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = document.querySelector('.leo2 .drawer.open') as HTMLElement | null;
      if (!root) return;
      const list = [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
      const next = nextFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (next < 0 || !list[next]) return;
      e.preventDefault();
      list[next].focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);
  const [stickBottom, setStickBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const rowCountRef = useRef(0);
  useEffect(() => { setStickBottom(true); setUnseen(0); rowCountRef.current = 0; setWsHits([]); setWsTruncated(false); setCommits([]); setLogError(null); setFocusCommit(null); setFailFocusKey(null); }, [active?.machine, active?.id]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(180, ta.scrollHeight)}px`;
    layoutFlow();
  }, [draftKey, draft, layoutFlow]);
  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const grew = sessionView.rows.length > rowCountRef.current;
    rowCountRef.current = sessionView.rows.length;
    setUnseen((n) => nextUnseen(n, grew, stickBottom));
    if (stickBottom) flow.scrollTop = flow.scrollHeight;
  }, [sessionView.rows, view, stickBottom]);

  // -- 动作 ------------------------------------------------------------------
  const openSession = useCallback((target: SessionTarget) => { setActive(target); setView('home'); }, []);
  const withBusy = useCallback(async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    try { await fn(); if (okText) toast(okText); await refreshLocal(); }
    catch (e) { toast(humanizeError(e instanceof Error ? e.message : String(e)), true); }
    finally { setBusy(false); }
  }, [toast, refreshLocal]);

  const continueHere = useCallback(() => {
    setNewBox(continueSessionDraft({ machine: active?.machine, cwd: activeSummary?.cwd, prompt: draft, model: sessionView.model || activeSummary?.model }));
    setView('home');
    setDrawer(null);
  }, [active, activeSummary, draft, sessionView.model]);
  const canResumeHere = Boolean(active && activeSummary && sessionCanResume({
    machine: active.machine, harness: activeSummary.harness, status: activeSummary.status, resumable: activeSummary.resumable,
  }));
  const resumeHere = useCallback(() => {
    if (!active || active.machine !== 'local') return;
    void withBusy(async () => {
      await api.continueLocal(active);
      await refreshLocal();
    }, '已接着这条会话');
  }, [active, refreshLocal, withBusy]);
  const ingestDroppedPaths = useCallback((paths: string[]) => {
    if (!paths.length) return;
    setDraft(paths.reduce((text, next) => mentionDroppedFile(text, next), draft));
    toast(paths.length === 1 ? `已放入 ${paths[0]!.split('/').pop()}` : `已放入 ${paths.length} 个文件`);
  }, [draft, setDraft, toast]);
  const dropIntoCwd = useCallback(async (files: File[]) => {
    const folder = activeSummary?.cwd?.trim() ?? '';
    if (!canAcceptSessionDrop({ machine: active?.machine, cwd: folder })) {
      toast('只有本机会话才能放入文件', true);
      return;
    }
    try {
      const paths: string[] = [];
      for (const file of files) paths.push(await dropBrowserFile(folder, file));
      ingestDroppedPaths(paths);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active?.machine, activeSummary?.cwd, ingestDroppedPaths, toast]);
  const onComposerPaste = useCallback((event: { preventDefault: () => void; clipboardData: DataTransfer | null }) => {
    const folder = activeSummary?.cwd?.trim() ?? '';
    if (!canAcceptSessionDrop({ machine: active?.machine, cwd: folder })) return;
    const data = event.clipboardData;
    const files = [...(data?.files ?? [])];
    const image = [...(data?.items ?? [])].find((item) => item.type.startsWith('image/'))?.getAsFile();
    if (files.length) {
      event.preventDefault();
      void dropIntoCwd(files);
      return;
    }
    if (image) {
      event.preventDefault();
      void dropIntoCwd([image]);
      return;
    }
    if (data?.getData('text')) return;
    event.preventDefault();
    void pasteSessionImage(folder).then((path) => {
      if (path) ingestDroppedPaths([path]);
      else toast('剪贴板里没有图', true);
    }).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
  }, [active?.machine, activeSummary?.cwd, dropIntoCwd, ingestDroppedPaths, toast]);
  const onComposerDrop = useCallback((event: { preventDefault: () => void; dataTransfer: DataTransfer }) => {
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (files.length) void dropIntoCwd(files);
  }, [dropIntoCwd]);
  const pickIntoSession = useCallback(async () => {
    const folder = activeSummary?.cwd?.trim() ?? '';
    if (!canAcceptSessionDrop({ machine: active?.machine, cwd: folder })) {
      toast('只有本机会话才能放入文件', true);
      return;
    }
    try { ingestDroppedPaths(await pickSessionFiles(folder)); }
    catch (error) { toast(humanizeError(error instanceof Error ? error.message : String(error)), true); }
  }, [active?.machine, activeSummary?.cwd, ingestDroppedPaths, toast]);
  const pasteShot = useCallback(async () => {
    const folder = activeSummary?.cwd?.trim() ?? '';
    if (!canAcceptSessionDrop({ machine: active?.machine, cwd: folder })) {
      toast('只有本机会话才能放入文件', true);
      return;
    }
    try {
      const path = await pasteSessionImage(folder);
      if (path) ingestDroppedPaths([path]);
      else toast('剪贴板里没有图', true);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active?.machine, activeSummary?.cwd, ingestDroppedPaths, toast]);
  const openTouchedFile = useCallback((file: string) => {
    const next = file.trim();
    if (next) setFocusFile(next);
    setDrawer('files');
  }, []);
  const newOnMachine = useCallback(() => {
    const machine = active?.machine && active.machine !== 'local' ? active.machine : 'local';
    setNewBox({ open: true, machine, cwd: activeSummary?.cwd || undefined });
    setView('home');
    setDrawer(null);
  }, [active, activeSummary]);
  const showDevice = useCallback(() => {
    const machine = active?.machine && active.machine !== 'local' ? active.machine : 'local';
    setFocusMachine(machine);
    setView('devices');
    setDrawer(null);
  }, [active]);
  const copyCwd = useCallback(async () => {
    const path = activeSummary?.cwd?.trim();
    if (!path) { toast('这条会话没有目录'); return; }
    try { await navigator.clipboard.writeText(path); toast('已复制路径'); }
    catch { toast('复制失败', true); }
  }, [activeSummary, toast]);
  const revealCwd = useCallback(async () => {
    const path = activeSummary?.cwd?.trim();
    if (!path) { toast('这条会话没有目录'); return; }
    try { await revealSessionPath(path); toast('已在 Finder 打开'); }
    catch (error) { toast(humanizeError(error instanceof Error ? error.message : String(error)), true); }
  }, [activeSummary, toast]);
  const revealFocusFile = useCallback(async () => {
    const file = focusFile?.trim();
    const root = activeSummary?.cwd ?? workspace?.fullPath ?? '';
    const path = file ? sessionFilePath(root, file) : root;
    if (!path) { toast('没有可打开的文件'); return; }
    try { await revealSessionPath(path); toast('已在 Finder 显示'); }
    catch (error) { toast(humanizeError(error instanceof Error ? error.message : String(error)), true); }
  }, [activeSummary?.cwd, focusFile, toast, workspace?.fullPath]);
  const openCwdTerm = useCallback(async () => {
    const path = activeSummary?.cwd?.trim();
    if (!canOpenSessionPath(active?.machine, path)) { toast('这条会话不能在终端打开', true); return; }
    try { await openSessionTerm(path!); toast('已在终端打开'); }
    catch (error) { toast(humanizeError(error instanceof Error ? error.message : String(error)), true); }
  }, [active?.machine, activeSummary, toast]);
  const openFocusFile = useCallback(async () => {
    const file = focusFile?.trim();
    const root = activeSummary?.cwd ?? workspace?.fullPath ?? '';
    const path = file ? sessionFilePath(root, file) : root;
    if (!canOpenSessionPath(active?.machine, path)) { toast('这份预览不能用默认程序打开', true); return; }
    try { await openSessionPath(path); toast('已用默认程序打开'); }
    catch (error) { toast(humanizeError(error instanceof Error ? error.message : String(error)), true); }
  }, [active?.machine, activeSummary?.cwd, focusFile, toast, workspace?.fullPath]);
  const savePeek = useCallback(async () => {
    const root = activeSummary?.cwd ?? workspace?.fullPath ?? '';
    const path = focusFile ? sessionFilePath(root, focusFile) : '';
    if (!workspace?.projectId || !peekCanWriteBack({ machine: active?.machine, projectId: workspace.projectId, path, peek: filePeek }) || filePeekDraft == null) {
      toast('这份预览不能写回', true);
      return;
    }
    try {
      await api.writeProjectFile(workspace.projectId, path, filePeekDraft);
      setFilePeek(filePeekDraft);
      toast('已写回磁盘');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active?.machine, activeSummary?.cwd, filePeek, filePeekDraft, focusFile, toast, workspace?.fullPath, workspace?.projectId]);
  const flushPeekForSend = useCallback(async (): Promise<boolean> => {
    const root = activeSummary?.cwd ?? workspace?.fullPath ?? '';
    const path = focusFile ? sessionFilePath(root, focusFile) : '';
    const projectId = workspace?.projectId;
    if (!projectId || filePeekDraft == null || !canFlushPeekOnSend({
      machine: active?.machine,
      projectId,
      path,
      peek: filePeek,
      draft: filePeekDraft,
    })) return true;
    try {
      await api.writeProjectFile(projectId, path, filePeekDraft);
      setFilePeek(filePeekDraft);
      toast(peekFlushedToast(focusFile));
      return true;
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
      return false;
    }
  }, [active?.machine, activeSummary?.cwd, filePeek, filePeekDraft, focusFile, toast, workspace?.fullPath, workspace?.projectId]);
  const revertFile = useCallback(async (file = focusFile) => {
    if (!active || !canRevertSessionFile(active.machine, file)) {
      toast('这份改动不能还原', true);
      return;
    }
    try {
      const result = await api.revertLocalFile(active, file!.trim());
      toast(revertSessionFileToast(result.action));
      if (result.action === 'removed' && focusFile === file) {
        setFocusFile(null);
        setFilePeek(null);
        setFilePeekDraft(null);
      } else {
        setPeekTick((tick) => tick + 1);
      }
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, focusFile, toast]);
  const commitFiles = useCallback(async () => {
    if (!active || !canCommitSessionFiles(active.machine, pinFiles)) {
      toast('还没有可记下的改动', true);
      return;
    }
    const message = defaultCommitMessage(commitDraft ?? (sessionView.title || activeSummary?.title || ''));
    try {
      const result = await api.commitLocalFiles(active, { message, files: pinFiles });
      toast(commitSessionFilesToast(result.hash));
      setCommitDraft(null);
      setPeekTick((tick) => tick + 1);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, activeSummary?.title, commitDraft, pinFiles, sessionView.title, toast]);
  const pushRepo = useCallback(async () => {
    if (!active || !canPushHere) return;
    try {
      const result = await api.pushLocalRepo(active);
      toast(pushSessionToast(result.remote, result.branch));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canPushHere, toast]);
  const pullRepo = useCallback(async () => {
    if (!active || !canPullHere) return;
    try {
      const result = await api.pullLocalRepo(active);
      toast(pullSessionToast(result.remote, result.branch, result.changed));
      setPeekTick((tick) => tick + 1);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canPullHere, toast]);
  const exportTalk = useCallback(async () => {
    if (!active || !canExportSession(active.machine, sessionView.rows)) {
      toast('还没有可记下的对话', true);
      return;
    }
    const title = sessionView.title || activeSummary?.title || '';
    try {
      const result = await api.exportLocalTalk(active, {
        name: exportFileName(title),
        markdown: flowRowsToMarkdown({
          title,
          cwd: activeSummary?.cwd,
          model: prettyModelName(sessionView.model),
          rows: sessionView.rows,
        }),
      });
      toast(exportSessionToast(result.name));
      setDraft(mentionDroppedFile(draft, result.path));
      setPeekTick((tick) => tick + 1);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, activeSummary?.cwd, activeSummary?.title, draft, sessionView.model, sessionView.rows, sessionView.title, setDraft, toast]);
  const copyTalk = useCallback(async () => {
    if (!canCopyTalk(active?.machine, sessionView.rows)) {
      toast('还没有可复制的对话', true);
      return;
    }
    const title = sessionView.title || activeSummary?.title || '';
    try {
      await navigator.clipboard.writeText(flowRowsToMarkdown({
        title,
        cwd: activeSummary?.cwd,
        model: prettyModelName(sessionView.model),
        rows: sessionView.rows,
      }));
      toast(copyTalkToast());
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active?.machine, activeSummary?.cwd, activeSummary?.title, sessionView.model, sessionView.rows, sessionView.title, toast]);
  const printTalk = useCallback(async () => {
    if (!canPrintTalk(active?.machine, sessionView.rows)) {
      toast('还没有可打印的对话', true);
      return;
    }
    const title = sessionView.title || activeSummary?.title || '这次对话';
    try {
      await printSessionTalk(title, clipPrintText(flowRowsToMarkdown({
        title,
        cwd: activeSummary?.cwd,
        model: prettyModelName(sessionView.model),
        rows: sessionView.rows,
      })));
      toast(printTalkToast());
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active?.machine, activeSummary?.cwd, activeSummary?.title, sessionView.model, sessionView.rows, sessionView.title, toast]);
  const toggleHideSecrets = useCallback(() => {
    if (!canHideSecrets(active?.machine, sessionView.rows)) {
      toast('这条里没有能藏的密钥', true);
      return;
    }
    setHideSecretsOn((on) => {
      const next = !on;
      toast(hideSecretsToast(next));
      return next;
    });
  }, [active?.machine, sessionView.rows, toast]);
  const toggleOpenAtLogin = useCallback(async () => {
    if (!canOpenAtLoginHere) {
      toast('这台电脑现在设不了开机就开', true);
      return;
    }
    try {
      const next = await writeOpenAtLogin(!openAtLogin);
      setOpenAtLogin(next);
      toast(openAtLoginToast(next));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canOpenAtLoginHere, openAtLogin, toast]);
  const toggleGlobalHotkey = useCallback(async () => {
    if (!canHotkeyHere) {
      toast('这台电脑现在设不了快捷键唤出', true);
      return;
    }
    try {
      const next = await writeGlobalHotkey(!globalHotkey);
      setGlobalHotkey(next);
      toast(globalHotkeyToast(next));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canHotkeyHere, globalHotkey, toast]);
  const relaunchHere = useCallback(async () => {
    if (!canRelaunchHere) {
      toast('这台电脑现在重新打不开', true);
      return;
    }
    if (relaunchBusy(allSessions)) {
      toast(relaunchBusyToast(), true);
      return;
    }
    try {
      toast(relaunchToast());
      await relaunchDesktop();
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [allSessions, canRelaunchHere, toast]);
  const extraHere = useCallback(async () => {
    if (!canExtraHere) {
      toast('这台电脑现在再开不了窗口', true);
      return;
    }
    try {
      await openDesktopExtraWindow();
      toast(extraWindowToast());
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canExtraHere, toast]);
  const emojiHere = useCallback(async () => {
    if (!canEmojiHere) {
      toast('这台电脑现在弹不出表情', true);
      return;
    }
    try {
      await openDesktopEmoji();
      toast(emojiToast());
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canEmojiHere, toast]);
  const clearCacheHere = useCallback(async () => {
    if (!canClearCacheHere) {
      toast('这台电脑现在清不掉缓存', true);
      return;
    }
    try {
      await clearDesktopCache();
      toast(clearCacheToast());
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canClearCacheHere, toast]);
  const lockHere = useCallback(async () => {
    if (!canLockHere) {
      toast('这台电脑现在锁不住', true);
      return;
    }
    try {
      const next = await writeAppLock(!appLocked);
      setAppLocked(next);
      toast(lockToast(next));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canLockHere, appLocked, toast]);
  const cliHere = useCallback(async () => {
    if (!canCliHere) {
      toast('这台电脑现在装不进终端', true);
      return;
    }
    try {
      const next = await writeCliInstall(!cliInstalled);
      setCliInstalled(next);
      toast(installCliToast(next));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canCliHere, cliInstalled, toast]);
  const appsHere = useCallback(async () => {
    if (!canAppsHere) {
      toast('这台电脑现在挪不进程序文件夹', true);
      return;
    }
    if (moveToApplicationsBusy(allSessions)) {
      toast(moveToApplicationsBusyToast(), true);
      return;
    }
    try {
      const result = await moveDesktopToApplications();
      setInApplications(Boolean(result.already || !result.moved));
      toast(moveToApplicationsToast(Boolean(result.already)));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [allSessions, canAppsHere, toast]);
  const checkUpdateHere = useCallback(async () => {
    if (!canCheckUpdateHere) {
      toast('这台电脑现在不能检查更新', true);
      return;
    }
    const action = nextUpdateAction(updateState);
    if (action === 'wait') {
      toast(checkUpdateToast(updateState));
      return;
    }
    try {
      const row = await runDesktopUpdate(action);
      setUpdateState(row);
      const failed = Boolean(row.error || row.status === 'error' || row.status === 'authentication-required' || row.status === 'development-build');
      toast(checkUpdateToast(row), failed);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canCheckUpdateHere, toast, updateState]);
  const followSystemHere = useCallback(() => {
    toast(followSystemToast(themeMode));
    if (themeMode !== 'system') setThemeMode('system');
  }, [setThemeMode, themeMode, toast]);
  const toggleAlwaysOnTop = useCallback(async () => {
    if (!canAlwaysOnTopHere) {
      toast('这台电脑现在钉不了窗口', true);
      return;
    }
    try {
      const next = await writeAlwaysOnTop(!alwaysOnTop);
      setAlwaysOnTop(next);
      toast(alwaysOnTopToast(next));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canAlwaysOnTopHere, alwaysOnTop, toast]);
  const toggleAllSpaces = useCallback(async () => {
    if (!canAllSpacesHere) {
      toast('这台电脑现在不能跟着每个桌面', true);
      return;
    }
    try {
      const next = await writeAllSpaces(!allSpaces);
      setAllSpaces(next);
      toast(allSpacesToast(next));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canAllSpacesHere, allSpaces, toast]);
  const toggleContentProtection = useCallback(async () => {
    if (!canProtectHere) {
      toast('这台电脑现在藏不住窗口', true);
      return;
    }
    try {
      const next = await writeContentProtection(!contentProtection);
      setContentProtection(next);
      toast(contentProtectionToast(next));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canProtectHere, contentProtection, toast]);
  const toggleDoneChime = useCallback(() => {
    if (!canDoneChimeHere) {
      toast('这台电脑现在响不了', true);
      return;
    }
    setDoneChimeOn((on) => {
      const next = !on;
      try { localStorage.setItem(DONE_CHIME_KEY, String(next)); } catch { /* ignore */ }
      toast(doneChimeToast(next));
      return next;
    });
  }, [canDoneChimeHere, toast]);
  const openLogsHere = useCallback(async () => {
    if (!canOpenLogsHere) {
      toast('这台电脑现在打不开日志', true);
      return;
    }
    try {
      await openDesktopLogs();
      toast(openLogsToast());
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canOpenLogsHere, toast]);
  const openA11yHere = useCallback(async () => {
    if (!canOpenA11yHere) {
      toast('这台电脑现在打不开辅助功能设置', true);
      return;
    }
    try {
      await openDesktopAccessibility();
      toast(openAccessibilityToast());
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canOpenA11yHere, toast]);
  const dictateHere = useCallback(() => {
    if (!canDictate(active?.machine)) {
      toast('只有本机能对着说', true);
      return;
    }
    if (dictateRef.current) {
      try { dictateRef.current.stop(); } catch { /* already gone */ }
      dictateRef.current = null;
      setDictating(false);
      toast(dictateStoppedToast());
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      toast(dictateUnavailableToast(), true);
      return;
    }
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (event) => {
      const heard = clipDictateText(event.results?.[0]?.[0]?.transcript);
      setDraft(appendDictate(draft, heard));
      toast(dictateToast(heard), !heard);
    };
    rec.onerror = (event) => {
      toast(event.error === 'not-allowed' ? '没开麦克风' : dictateUnavailableToast(), true);
    };
    rec.onend = () => {
      dictateRef.current = null;
      setDictating(false);
    };
    dictateRef.current = rec;
    setDictating(true);
    toast(dictateListeningToast());
    try {
      rec.start();
    } catch {
      dictateRef.current = null;
      setDictating(false);
      toast(dictateUnavailableToast(), true);
    }
  }, [active?.machine, draft, setDraft, toast]);
  const searchHere = useCallback(async () => {
    if (!active || !canSearchHere) return;
    if (!searchQueryReady(wsQuery)) { toast('至少两个字才能搜', true); return; }
    try {
      const row = await api.searchLocalCwd(active, wsQuery);
      setWsHits(row.hits);
      setWsTruncated(row.truncated);
      toast(searchSessionToast(row.hits.length, row.truncated));
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canSearchHere, toast, wsQuery]);
  const openSearch = useCallback(() => {
    if (!canSearchHere) return;
    setDrawer('files');
    window.setTimeout(() => { wsSearchRef.current?.focus(); wsSearchRef.current?.select(); }, 0);
  }, [canSearchHere]);
  const openLog = useCallback(() => {
    if (!canShowSessionLog(active?.machine)) return;
    setDrawer('diff');
  }, [active?.machine]);
  const pickFolder = useCallback(async () => {
    try {
      const next = await pickSessionFolder();
      if (!next) return null;
      warnIcloud(next);
      return next;
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
      return null;
    }
  }, [toast, warnIcloud]);
  const copyTitle = useCallback(async () => {
    const text = (sessionView.title || activeSummary?.title || '').trim();
    if (!text) { toast('这条会话还没有标题'); return; }
    try { await navigator.clipboard.writeText(text); toast('已复制标题'); }
    catch { toast('复制失败', true); }
  }, [activeSummary?.title, sessionView.title, toast]);
  const mentionLast = useCallback(() => {
    const reply = lastAiReply(sessionView.rows);
    if (!reply) { toast('还没有模型上一句', true); return; }
    setDraft(mentionLastReply(draft, reply));
    toast(mentionLastReplyToast());
    window.setTimeout(() => taRef.current?.focus(), 0);
  }, [draft, sessionView.rows, setDraft, toast]);
  const copyLastReply = useCallback(async () => {
    const reply = lastAiReply(sessionView.rows);
    if (!reply) { toast('还没有模型上一句', true); return; }
    try { await navigator.clipboard.writeText(reply); toast(copyLastReplyToast()); }
    catch { toast('复制失败', true); }
  }, [sessionView.rows, toast]);
  const speakLast = useCallback(() => {
    const reply = lastAiReply(sessionView.rows);
    if (!canSpeakLastReply(active?.machine, sessionView.rows) || !reply) {
      toast('还没有可读的一句', true);
      return;
    }
    void speakSessionText(reply).then(() => toast(speakLastReplyToast())).catch((error) => {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    });
  }, [active?.machine, sessionView.rows, toast]);
  const retryLast = useCallback(async () => {
    if (!active || !canRetryLast) return;
    const text = lastUserPrompt(sessionView.rows);
    if (!text) { toast('还没有上一句', true); return; }
    const blocked = composerNeedsModelSwitch(sessionView.model, sessionFailTexts({
      lastEventText: activeSummary?.last_event?.text,
      rows: sessionView.rows,
    }));
    if (blocked) {
      toast('先换一个模型再发。当前这个账号用不了。', true);
      return;
    }
    if (isBrowserOffline(typeof navigator === 'undefined' ? null : navigator)) {
      toast(offlineToast(), true);
      return;
    }
    if (!(await flushPeekForSend())) return;
    warnBatterySend();
    warnThermalSend();
    warnMemorySend();
    warnLoadSend();
    await withBusy(() => api.send(active, text), retryLastUserToast());
  }, [active, activeSummary?.last_event?.text, canRetryLast, flushPeekForSend, sessionView.model, sessionView.rows, toast, withBusy, warnBatterySend, warnThermalSend, warnMemorySend, warnLoadSend]);
  const editLastPrompt = useCallback(() => {
    const text = lastUserPrompt(sessionView.rows);
    if (!text) { toast('还没有上一句', true); return; }
    setDraft(editLastPromptDraft(draft, text));
    toast(editLastPromptToast());
    window.setTimeout(() => taRef.current?.focus(), 0);
  }, [draft, sessionView.rows, setDraft, toast]);
  const rewindLast = useCallback(async () => {
    if (!active || !canRewindHere) {
      toast('现在不能拿掉上一轮', true);
      return;
    }
    const prompt = lastUserPrompt(sessionView.rows);
    await withBusy(async () => {
      const result = await api.rewindLocal(active);
      setDraft(result.prompt || prompt);
    }, rewindLastTurnToast());
    window.setTimeout(() => taRef.current?.focus(), 0);
  }, [active, canRewindHere, sessionView.rows, setDraft, toast, withBusy]);
  const mentionTool = useCallback(() => {
    const text = lastToolOutput(sessionView.rows);
    if (!text) { toast('还没有刚打出来的', true); return; }
    setDraft(mentionLastTool(draft, text));
    toast(mentionLastToolToast());
    window.setTimeout(() => taRef.current?.focus(), 0);
  }, [draft, sessionView.rows, setDraft, toast]);
  const openLastWritten = useCallback(() => {
    const file = lastWrittenFile(sessionView.rows);
    if (!file || !canOpenWritten) {
      toast('还没有刚写下的文件', true);
      return;
    }
    setFocusCommit(null);
    setFocusFile(file);
    setDrawer('files');
    toast(openLastWrittenToast(file));
  }, [canOpenWritten, sessionView.rows, toast]);
  const jumpLastFail = useCallback(() => {
    const row = lastFailedRow(sessionView.rows);
    if (!row || !canJumpFail) {
      toast('还没有刚失败的', true);
      return;
    }
    setView('home');
    setStickBottom(false);
    setFailFocusKey(row.key);
    toast(jumpLastFailToast(row));
  }, [canJumpFail, sessionView.rows, toast]);
  const openLastRead = useCallback(() => {
    const file = lastReadFile(sessionView.rows);
    if (!file || !canOpenRead) {
      toast('还没有刚读过的文件', true);
      return;
    }
    setFocusCommit(null);
    setFocusFile(file);
    setDrawer('files');
    toast(openLastReadToast(file));
  }, [canOpenRead, sessionView.rows, toast]);
  const applyPatch = useCallback(async () => {
    if (!active || !canApplyHere) return;
    try {
      const raw = await navigator.clipboard.readText();
      const patch = clipApplyPatch(raw);
      const result = await api.applyLocalPatch(active, patch);
      toast(applyPatchToast(result.files));
      setPeekTick((tick) => tick + 1);
      if (result.files[0]) { setFocusCommit(null); setFocusFile(result.files[0]); }
      setDrawer((cur) => cur ?? 'diff');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canApplyHere, toast]);
  const packChanges = useCallback(async () => {
    if (!active || !canPackHere) return;
    const title = sessionView.title || activeSummary?.title || '';
    try {
      const result = await api.packLocalChanges(active, { name: packFileName(title), files: pinFiles });
      toast(packSessionToast(result.name, result.files.length));
      setPeekTick((tick) => tick + 1);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, activeSummary?.title, canPackHere, pinFiles, sessionView.title, toast]);
  const unpackZip = useCallback(async () => {
    if (!active || !canUnpackHere) return;
    try {
      const result = await api.unpackLocalZip(active, { name: unpackZipName(focusFile) });
      toast(unpackSessionToast(result.name, result.files.length));
      setPeekTick((tick) => tick + 1);
      if (result.files[0]) { setFocusCommit(null); setFocusFile(result.files[0]); }
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canUnpackHere, focusFile, toast]);
  const seedFile = useCallback(async () => {
    if (!active || !canSeedHere) return;
    try {
      let text = '';
      try { text = clipSeedText(await navigator.clipboard.readText()); } catch { text = ''; }
      const result = await api.seedLocalFile(active, { name: sanitizeSeedRel(seedName), text });
      toast(seedSessionToast(result.file));
      setSeedName('');
      setPeekTick((tick) => tick + 1);
      setFocusCommit(null);
      setFocusFile(result.file);
      setDrawer((cur) => cur ?? 'files');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canSeedHere, seedName, toast]);
  const trashFile = useCallback(async (file = focusFile) => {
    if (!active || !canTrashSessionFile(active.machine, file)) {
      toast('先点开一份文件', true);
      return;
    }
    try {
      const result = await api.trashLocalFile(active, file!.trim());
      toast(trashSessionToast(result.file));
      if (focusFile === file) {
        setFocusFile(null);
        setFilePeek(null);
        setFilePeekDraft(null);
      }
      setPeekTick((tick) => tick + 1);
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, focusFile, toast]);
  const duplicateFile = useCallback(async (file = focusFile) => {
    if (!active || !canDuplicateSessionFile(active.machine, file)) {
      toast('先点开一份文件', true);
      return;
    }
    try {
      const result = await api.duplicateLocalFile(active, file!.trim());
      toast(duplicateSessionToast(result.file));
      setPeekTick((tick) => tick + 1);
      setFocusCommit(null);
      setFocusFile(result.file);
      setDrawer((cur) => cur ?? 'files');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, focusFile, toast]);
  const mkdirFolder = useCallback(async () => {
    if (!active || !canMkdirHere) return;
    try {
      const result = await api.mkdirLocalFolder(active, sanitizeFolderRel(folderName));
      toast(mkdirSessionToast(result.folder));
      setFolderName('');
      setPeekTick((tick) => tick + 1);
      setDrawer((cur) => cur ?? 'files');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canMkdirHere, folderName, toast]);
  const switchBranch = useCallback(async () => {
    if (!active || !canBranchHere) return;
    try {
      const result = await api.switchLocalBranch(active, sanitizeBranchName(branchName));
      toast(switchSessionBranchToast(result.branch, result.created));
      setBranchName('');
      setPeekTick((tick) => tick + 1);
      setDrawer((cur) => cur ?? 'diff');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, branchName, canBranchHere, toast]);
  const initRepo = useCallback(async () => {
    if (!active || !canInitHere) return;
    try {
      const result = await api.initLocalRepo(active);
      toast(initSessionToast(result.created, result.branch));
      setPeekTick((tick) => tick + 1);
      setDrawer((cur) => cur ?? 'diff');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, canInitHere, toast]);
  const mergeBranch = useCallback(async () => {
    if (!active || !canMergeHere) return;
    if (!branchName.trim()) {
      toast('写要并过来的分支', true);
      return;
    }
    try {
      const result = await api.mergeLocalBranch(active, sanitizeBranchName(branchName));
      toast(mergeSessionToast(result.from, result.into, result.already));
      setBranchName('');
      setPeekTick((tick) => tick + 1);
      setDrawer((cur) => cur ?? 'diff');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, branchName, canMergeHere, toast]);
  const moveFile = useCallback(async (file = focusFile) => {
    if (!active || !canMoveSessionFile(active.machine, file)) {
      toast('先点开一份文件', true);
      return;
    }
    try {
      const result = await api.moveLocalFile(active, file!.trim(), sanitizeMoveFolder(moveDest));
      toast(moveSessionToast(result.file));
      setMoveDest('');
      setPeekTick((tick) => tick + 1);
      setFocusCommit(null);
      setFocusFile(result.file);
      setDrawer((cur) => cur ?? 'files');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, focusFile, moveDest, toast]);
  const beginRename = useCallback(() => {
    if (!canRenameSession(active?.machine)) return;
    setTitleDraft(sessionView.title || activeSummary?.title || '');
    setTitleEditing(true);
    window.setTimeout(() => { titleEditRef.current?.focus(); titleEditRef.current?.select(); }, 0);
  }, [active?.machine, activeSummary?.title, sessionView.title]);
  const renameTitle = useCallback(async () => {
    if (!active || !canRenameSession(active.machine)) return;
    const next = clipSessionTitle(titleDraft ?? sessionView.title ?? activeSummary?.title ?? '');
    if (!next) { toast('写一个标题', true); return; }
    try {
      const result = await api.renameLocalSession(active, next);
      toast(renameSessionToast(result.title));
      setTitleEditing(false);
      setTitleDraft(null);
      await refreshLocal();
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, activeSummary?.title, refreshLocal, sessionView.title, titleDraft, toast]);
  const beginRule = useCallback(() => {
    if (!canSetSessionRule(active?.machine)) return;
    setRuleDraft(sessionView.rule || activeSummary?.rule || '');
    setRuleEditing(true);
    window.setTimeout(() => { ruleEditRef.current?.focus(); ruleEditRef.current?.select(); }, 0);
  }, [active?.machine, activeSummary?.rule, sessionView.rule]);
  const saveRule = useCallback(async () => {
    if (!active || !canSetSessionRule(active.machine)) return;
    const next = clipSessionRule(ruleDraft ?? sessionView.rule ?? activeSummary?.rule ?? '');
    try {
      const result = await api.setLocalSessionRule(active, next);
      toast(ruleSessionToast(result.rule));
      setRuleEditing(false);
      setRuleDraft(null);
      await refreshLocal();
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, activeSummary?.rule, refreshLocal, ruleDraft, sessionView.rule, toast]);
  const beginCwdRule = useCallback(() => {
    if (!canSetCwdRule(active?.machine)) return;
    setCwdRuleDraft(sessionView.cwdRule || activeSummary?.cwd_rule || '');
    setCwdRuleEditing(true);
    setDrawer('files');
    window.setTimeout(() => { cwdRuleEditRef.current?.focus(); cwdRuleEditRef.current?.select(); }, 0);
  }, [active?.machine, activeSummary?.cwd_rule, sessionView.cwdRule]);
  const saveCwdRule = useCallback(async () => {
    if (!active || !canSetCwdRule(active.machine)) return;
    const next = clipCwdRule(cwdRuleDraft ?? sessionView.cwdRule ?? activeSummary?.cwd_rule ?? '');
    try {
      const result = await api.setLocalCwdRule(active, next);
      toast(cwdRuleToast(result.cwd_rule));
      setCwdRuleEditing(false);
      setCwdRuleDraft(null);
      await refreshLocal();
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [active, activeSummary?.cwd_rule, cwdRuleDraft, refreshLocal, sessionView.cwdRule, toast]);
  const copyFindHit = useCallback(async () => {
    const row = sessionView.rows.find((item) => item.key === findKey);
    const text = flowFindHitText(row).trim();
    if (!text) { toast('没有可复制的命中'); return; }
    try { await navigator.clipboard.writeText(text); toast('已复制命中'); }
    catch { toast('复制失败', true); }
  }, [findKey, sessionView.rows, toast]);
  const hideSession = useCallback((target: SessionTarget) => {
    const key = sessionKey(target.machine, target.id);
    setHiddenKeys((prev) => {
      const next = addHiddenSessionKey(prev, key);
      try { localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    if (active?.machine === target.machine && active.id === target.id) setActive(null);
  }, [active]);
  const togglePin = useCallback((target: SessionTarget) => {
    const key = sessionKey(target.machine, target.id);
    setPinnedKeys((prev) => {
      const next = togglePinnedSessionKey(prev, key);
      try { localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      toast(pinSessionToast(next.includes(key)));
      return next;
    });
  }, [toast]);
  const forgetSession = useCallback(async (target: SessionTarget) => {
    const summary = allSessions.find((x) => x.machine === target.machine && x.s.session_id === target.id)?.s;
    if (summary && !sessionCanForget(summary.status)) { toast('进行中的会话要先停止,再从左栏拿掉', true); return; }
    if (target.machine === 'local') {
      await withBusy(async () => {
        await api.forget(target);
        hideSession(target);
      }, '已从左栏拿掉。日志还在本机,只是不再召回。');
      return;
    }
    hideSession(target);
    toast('已从这台 Mac 的左栏拿掉。那台机器上的记录还在。');
  }, [allSessions, hideSession, toast, withBusy]);
  const send = useCallback(async () => {
    if (!active) return;
    const text = draft.trim(); if (!text) return;
    const blocked = composerNeedsModelSwitch(sessionView.model, sessionFailTexts({
      lastEventText: activeSummary?.last_event?.text,
      rows: sessionView.rows,
    }));
    if (blocked) {
      toast('先换一个模型再发。当前这个账号用不了。', true);
      return;
    }
    if (isBrowserOffline(typeof navigator === 'undefined' ? null : navigator)) {
      toast(offlineToast(), true);
      return;
    }
    if (!(await flushPeekForSend())) return;
    warnBatterySend();
    warnThermalSend();
    warnMemorySend();
    warnLoadSend();
    setDraft('');
    if (canResumeThenSend({ machine: active.machine, canResume: canResumeHere, prompt: text })) {
      await withBusy(async () => {
        await api.continueLocal(active);
        await api.send(active, text);
      }, resumeThenSendToast());
      return;
    }
    await withBusy(() => api.send(active, text));
  }, [active, activeSummary, canResumeHere, draft, flushPeekForSend, sessionView.model, sessionView.rows, toast, withBusy, setDraft, warnBatterySend, warnThermalSend, warnMemorySend, warnLoadSend]);
  const followUp = useCallback(async () => {
    if (!active || !composerCanFollowUp(active.machine, sessionView.status)) return;
    const text = draft.trim(); if (!text) return;
    const blocked = composerNeedsModelSwitch(sessionView.model, sessionFailTexts({
      lastEventText: activeSummary?.last_event?.text,
      rows: sessionView.rows,
    }));
    if (blocked) {
      toast('先换一个模型再发。当前这个账号用不了。', true);
      return;
    }
    if (isBrowserOffline(typeof navigator === 'undefined' ? null : navigator)) {
      toast(offlineToast(), true);
      return;
    }
    if (!(await flushPeekForSend())) return;
    warnBatterySend();
    warnThermalSend();
    warnMemorySend();
    warnLoadSend();
    setDraft('');
    await withBusy(() => api.rpc(active, { type: 'follow_up', message: text }), followUpToast());
  }, [active, activeSummary, draft, flushPeekForSend, sessionView.model, sessionView.rows, sessionView.status, toast, withBusy, setDraft, warnBatterySend, warnThermalSend, warnMemorySend, warnLoadSend]);
  const clearFollowUps = useCallback(() => {
    if (!active || !composerCanFollowUp(active.machine, sessionView.status)) return;
    void withBusy(() => api.rpc(active, { type: 'clear_queue' }), queueClearedToast());
  }, [active, sessionView.status, withBusy]);
  const stopTarget = useCallback(async (target: SessionTarget, title?: string | null) => {
    if (target.machine !== 'local') return;
    try {
      await api.stop(target);
      toast(stopSessionToast(title));
      await refreshLocal();
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [refreshLocal, toast]);
  const stop = useCallback(() => {
    if (!active || !canStopSession(active.machine, sessionView.status)) return;
    void stopTarget(active, sessionView.title || activeSummary?.title);
  }, [active, activeSummary?.title, sessionView.status, sessionView.title, stopTarget]);
  const haltBusy = useCallback(async () => {
    if (!canHaltBusy) return;
    try {
      const result = await api.haltBusyLocal();
      toast(haltSessionsToast(result.count));
      await refreshLocal();
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canHaltBusy, refreshLocal, toast]);
  const forgetEnded = useCallback(async () => {
    if (!canForgetEnded) return;
    const ids = endedLocalSessionIds(allSessions, pinnedKeys);
    try {
      const result = await api.forgetEndedLocal(ids);
      for (const id of result.ids) hideSession({ machine: 'local', id });
      toast(forgetEndedToast(result.count));
      await refreshLocal();
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [allSessions, canForgetEnded, hideSession, pinnedKeys, refreshLocal, toast]);
  const recallForgotten = useCallback(async (sessionId: string) => {
    try {
      const result = await api.recallForgottenLocal(sessionId);
      const key = sessionKey('local', result.session_id);
      setHiddenKeys((prev) => {
        const next = removeHiddenSessionKey(prev, key);
        try { localStorage.setItem(HIDDEN_SESSIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
      toast(recallSessionToast(result.title));
      setPicker(null);
      await refreshLocal();
      setActive({ machine: 'local', id: result.session_id });
      setView('home');
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [refreshLocal, toast]);
  const openRecall = useCallback(async () => {
    if (!canRecallHere) return;
    try {
      const result = await api.listForgottenLocal();
      if (!result.sessions.length) { toast('没有拿掉的会话'); return; }
      if (result.sessions.length === 1) {
        await recallForgotten(result.sessions[0].session_id);
        return;
      }
      setForgotten(result.sessions);
      setPicker({ kind: 'recall', query: '', index: 0 });
    } catch (error) {
      toast(humanizeError(error instanceof Error ? error.message : String(error)), true);
    }
  }, [canRecallHere, recallForgotten, toast]);
  const openHere = useCallback((sessionId?: string) => {
    if (sessionId) {
      const row = herePeers.find((item) => item.session_id === sessionId) ?? hereRows.find((item) => item.session_id === sessionId);
      openSession({ machine: 'local', id: sessionId });
      setPicker(null);
      toast(sameCwdToast(row?.title));
      return;
    }
    if (!canHere) {
      toast('这个目录没有别的会话');
      return;
    }
    if (herePeers.length === 1) {
      openHere(herePeers[0].session_id);
      return;
    }
    setHereRows(herePeers);
    setPicker({ kind: 'here', query: '', index: 0 });
  }, [canHere, herePeers, hereRows, openSession, toast]);
  const showPulse = useCallback(() => {
    if (!canPulse) {
      toast('这条还没开始聊');
      return;
    }
    toast(sessionPulseToast(pulseLabel));
  }, [canPulse, pulseLabel, toast]);
  const forkHere = useCallback(async () => {
    const cwd = activeSummary?.cwd?.trim() ?? '';
    if (!canFork || !cwd) {
      toast('这条还分不出来');
      return;
    }
    if (providers === null) return;
    if (usableModelsFromProviders(providers).length === 0) {
      setView('settings');
      toast(humanizeError('还没有登录任何模型。先去设置里授权或填密钥。'), true);
      return;
    }
    const named = forkTitle(sessionView.title || activeSummary?.title);
    const seed = forkSeedText({
      title: sessionView.title || activeSummary?.title,
      cwd,
      model: sessionView.model || activeSummary?.model,
      rows: sessionView.rows,
    });
    await withBusy(async () => {
      const created = await api.createLocalSession({
        cwd,
        prompt: seed,
        model: sessionView.model || activeSummary?.model,
        policy: sessionView.policy,
      });
      try {
        await api.renameLocalSession({ machine: 'local', id: created.session_id }, named);
      } catch {
        // 分出来的会话已经在跑,标题写不上也不挡接着干。
      }
      setActive({ machine: 'local', id: created.session_id });
      toast(forkSessionToast(named));
    });
  }, [activeSummary, canFork, providers, sessionView.model, sessionView.policy, sessionView.rows, sessionView.title, toast, withBusy]);
  const importTalk = useCallback(async () => {
    const cwd = activeSummary?.cwd?.trim() ?? '';
    if (!active || !canImportHere || !cwd) {
      toast('这条接不回来', true);
      return;
    }
    if (providers === null) return;
    if (usableModelsFromProviders(providers).length === 0) {
      setView('settings');
      toast(humanizeError('还没有登录任何模型。先去设置里授权或填密钥。'), true);
      return;
    }
    await withBusy(async () => {
      const row = await api.importLocalTalk(active, { name: importTalkName(focusFile) });
      const named = importTitle(row.name);
      const created = await api.createLocalSession({
        cwd,
        prompt: importSeedText({ name: row.name, markdown: row.markdown }),
        model: sessionView.model || activeSummary?.model,
        policy: sessionView.policy,
      });
      try {
        await api.renameLocalSession({ machine: 'local', id: created.session_id }, named);
      } catch {
        // 接回来的会话已经在跑,标题写不上也不挡接着干。
      }
      setActive({ machine: 'local', id: created.session_id });
      toast(importTalkToast(row.name));
    });
  }, [active, activeSummary, canImportHere, focusFile, providers, sessionView.model, sessionView.policy, toast, withBusy]);
  const openTalkLink = useCallback((url?: string) => {
    const target = url?.trim() || (talkLinks.length === 1 ? talkLinks[0].url : '');
    if (target) {
      void openSessionUrl(target).then(() => {
        setPicker(null);
        toast(talkLinkToast(target));
      }).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
      return;
    }
    if (!canLinks) {
      toast('这条没有链接');
      return;
    }
    setPicker({ kind: 'link', query: '', index: 0 });
  }, [canLinks, talkLinks, toast]);
  const approveTarget = useCallback((target: SessionTarget, approvalId: string, choice: string, reason?: string) => (
    withBusy(() => api.approve(target, approvalId, choice, reason), choice === 'deny' ? denySessionToast(reason ?? '') : approvalToast(choice))
  ), [withBusy]);
  const approve = useCallback((approvalId: string, choice: string, reason?: string) => active && approveTarget(active, approvalId, choice, reason), [active, approveTarget]);
  useEffect(() => onSessionNoticeAction((target) => {
    void approveTarget(target, target.approvalId, target.choice);
  }), [approveTarget]);
  const setPolicy = useCallback((policy: string) => {
    saveCwdHabit(activeSummary?.cwd, { policy });
    return active && withBusy(() => api.setPolicy(active, policy));
  }, [active, activeSummary?.cwd, withBusy]);
  const setModel = useCallback((provider: string, modelId: string) => {
    if (!active) return;
    saveCwdHabit(activeSummary?.cwd, { model: `${provider}/${modelId}` });
    const next = `${provider}/${modelId}`;
    const prompt = lastUserPrompt(sessionView.rows);
    const wasBlocked = composerNeedsModelSwitch(sessionView.model, sessionFailTexts({
      lastEventText: activeSummary?.last_event?.text,
      rows: sessionView.rows,
    }));
    const retry = canRetryAfterModelSwitch({
      machine: active.machine,
      wasBlocked,
      prevModel: sessionView.model,
      nextModel: next,
      prompt,
    });
    return withBusy(async () => {
      await api.rpc(active, { type: 'set_model', provider, modelId });
      if (!retry) return;
      if (!(await flushPeekForSend())) return;
      if (canResumeThenSend({ machine: active.machine, canResume: canResumeHere, prompt })) {
        await api.continueLocal(active);
      }
      await api.send(active, prompt);
    }, retry ? retryAfterModelSwitchToast() : undefined);
  }, [active, activeSummary?.cwd, activeSummary?.last_event?.text, canResumeHere, flushPeekForSend, sessionView.model, sessionView.rows, withBusy]);
  const setThinking = useCallback((level: string) => active && withBusy(() => api.rpc(active, { type: 'set_thinking_level', level })), [active, withBusy]);
  const compact = useCallback(() => active && withBusy(() => api.rpc(active, { type: 'compact' }), '压缩请求已发出'), [active, withBusy]);
  const abortTurn = useCallback(() => {
    if (!active || !canAbortTurnHere) return;
    return withBusy(() => api.rpc(active, { type: 'abort' }), abortTurnToast());
  }, [active, canAbortTurnHere, withBusy]);
  const approveFirstPending = useCallback(() => {
    const first = sessionView.pendingApprovals.values().next().value as (FlowRow & { k: 'ap' }) | undefined;
    if (first) void approve(first.approvalId, 'once');
    else if (othersNeedingYou[0]) openSession({ machine: othersNeedingYou[0].machine, id: othersNeedingYou[0].s.session_id });
    else toast('没有待批');
  }, [sessionView.pendingApprovals, othersNeedingYou, approve, openSession, toast]);
  const approveAllPending = useCallback(async () => {
    const ids = pendingApprovalIds(sessionView.pendingApprovals.values());
    if (!active || !canApproveAllHere(active.machine, ids)) {
      toast('还没有一批待批', true);
      return;
    }
    await withBusy(async () => {
      for (const id of ids) await api.approve(active, id, 'once');
    }, approveAllToast(ids.length));
  }, [active, sessionView.pendingApprovals, toast, withBusy]);
  const denyAllPending = useCallback(async () => {
    const ids = deniableApprovalIds(sessionView.pendingApprovals.values());
    if (!active || !canDenyAllHere(active.machine, ids)) {
      toast('还没有一批待批', true);
      return;
    }
    await withBusy(async () => {
      for (const id of ids) await api.approve(active, id, 'deny');
    }, denyAllToast(ids.length));
  }, [active, sessionView.pendingApprovals, toast, withBusy]);

  const openWindowOp = useCallback(() => {
    if (!active || active.machine !== 'local') return;
    const label = windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window)) || '还没绑窗口';
    setWindowOp({ label, draft: '', windows: [], peek: null, menus: [] });
    void api.listSessionWindows(active).then((row) => {
      setWindowOp((cur) => (cur ? { ...cur, windows: row.windows } : cur));
    }).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
    if (label !== '还没绑窗口') {
      void api.peekBoundWindow(active).then((row) => {
        const peek = row.image?.data ? `data:${row.image.mimeType || 'image/jpeg'};base64,${row.image.data}` : null;
        setWindowOp((cur) => (cur ? { ...cur, peek, label: windowBoundLabel({ app: row.app, title: row.title }) || cur.label } : cur));
      }).catch(() => {
        // 没录屏权限时仍可绑、可点,只是看不见画面。
      });
      void api.listBoundWindowMenus(active).then((row) => {
        setWindowOp((cur) => (cur ? { ...cur, menus: usableWindowMenus(row.menus), label: windowBoundLabel({ app: row.app, title: row.title }) || cur.label } : cur));
      }).catch(() => {
        setWindowOp((cur) => (cur ? { ...cur, menus: [] } : cur));
      });
    }
  }, [active, activeSummary?.window, sessionView.window, toast]);

  const readBoundField = useCallback(() => {
    if (!active || active.machine !== 'local') return;
    void api.readBoundWindow(active).then((result) => {
      setWindowOp((cur) => (cur ? { ...cur, draft: result.text, label: windowBoundLabel({ app: result.app, title: result.title }) || cur.label } : cur));
      setDraft((cur) => mentionWindowRead(cur, result.text));
      toast(result.text ? `已读回 ${result.app}` : `输入框是空的 · ${result.app}`);
    }).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
  }, [active, setDraft, toast]);

  const createSession = useCallback(async (input: { machine: string; cwd: string; prompt: string; model: string | null; policy: string }) => {
    if (input.machine === 'local' && isBrowserOffline(typeof navigator === 'undefined' ? null : navigator)) {
      toast(offlineToast(), true);
      return;
    }
    if (input.machine === 'local') {
      warnBatterySend();
      warnThermalSend();
      warnMemorySend();
      warnLoadSend();
    }
    if (input.machine === 'local' && await warnMissing(input.cwd)) return;
    if (input.machine === 'local' && (providers === null || usableModelsFromProviders(providers).length === 0)) {
      if (providers === null) return;
      setNewBox(null);
      setView('settings');
      toast(humanizeError('还没有登录任何模型。先去设置里授权或填密钥。'), true);
      return;
    }
    await withBusy(async () => {
      if (input.machine === 'local') {
        warnIcloud(input.cwd);
        saveCwdHabit(input.cwd, { model: input.model, policy: input.policy });
        const created = await api.createLocalSession({ cwd: input.cwd, prompt: input.prompt.trim() || null, model: input.model, policy: input.policy });
        setActive({ machine: 'local', id: created.session_id });
      } else {
        const created = await api.createRemoteSession({ machine: input.machine, cwd: input.cwd, prompt: input.prompt, model: input.model, policy: input.policy });
        await refreshFleet();
        setActive({ machine: input.machine, id: created.session_id });
      }
      setNewBox(null); setView('home');
    }, input.machine === 'local' && !input.prompt.trim() ? openIdleToast() : undefined);
  }, [providers, withBusy, refreshFleet, toast, warnIcloud, warnMissing, warnBatterySend, warnThermalSend, warnMemorySend, warnLoadSend]);

  // -- 菜单 ------------------------------------------------------------------
  const openMenu = useCallback((el: HTMLElement, items: MenuItem[], onPick: (v: string) => void) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: Math.min(r.left, window.innerWidth - 270), y: r.bottom + 6, items, onPick });
  }, []);
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const id = window.setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    return () => { window.clearTimeout(id); document.removeEventListener('click', close); };
  }, [menu]);

  const configuredModels = useMemo<ModelChoice[]>(() => rankModelsForPicker(usableModelsFromProviders(providers ?? []), modelLikelyUnusable), [providers]);
  const recentCwds = useMemo(() => [...new Set(allSessions.map((x) => x.s.cwd).filter(Boolean))].slice(0, 10), [allSessions]);
  const beginLocalNew = useCallback(() => {
    void refreshProviders();
    if (providers === null) return;
    if (localCreateNeedsSettings(configuredModels.length)) {
      setNewBox(null);
      setView('settings');
      return;
    }
    setNewBox((current) => (current?.open ? null : { open: true, machine: 'local' }));
    setView('home');
  }, [configuredModels.length, providers, refreshProviders]);
  useEffect(() => onDockNew(() => {
    beginLocalNew();
    toast(dockNewToast());
  }), [beginLocalNew, toast]);

  const modelMenu = () => setPicker({ kind: 'model', query: '', index: 0 });
  const policyMenu = () => setPicker({ kind: 'policy', query: '', index: 0 });
  const thinkMenu = () => setPicker({ kind: 'think', query: '', index: 0 });
  const moreMenu = (el: HTMLElement) => openMenu(el, [
    { v: 'term', t: '终端', sub: '⌘T' }, { v: 'files', t: '文件', sub: '⌘E' }, { v: 'diff', t: '本次改动', sub: '⌘D' }, { v: 'browser', t: '浏览器', sub: '⌘B' },
    { v: 'find', t: '在这条会话里找', sub: '⌘F' },
    { v: 'findhit', t: '复制当前命中', sub: '⌘C' },
    { v: '', t: '', sep: true },
    ...(active?.machine === 'local' ? [{ v: 'winbind', t: boundWindowChipKind(active.machine, windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window))) === 'raise' ? '换一扇窗' : '绑窗口', sub: windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window)) || '列出本机窗口' }] : []),
    ...(boundWindowChipKind(active?.machine ?? '', windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window))) === 'raise' ? [{ v: 'winclick', t: '操作这个窗口', sub: windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window)) }, { v: 'winread', t: '读回窗口里的字', sub: windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window)) }] : []),
    ...(activeSummary?.cwd?.trim() && active?.machine === 'local' ? [{ v: 'finder', t: '在 Finder 打开', sub: activeSummary.cwd }, { v: 'termapp', t: '在终端打开', sub: activeSummary.cwd }] : []),
    ...(activeSummary?.cwd?.trim() && active?.machine === 'local' ? [{ v: 'dropfile', t: '放入文件' }, { v: 'dropshot', t: '粘贴截图' }] : []),
    ...(active?.machine === 'local' && focusFile ? [{ v: 'openfile', t: '用默认程序打开', sub: peekFileCaption(focusFile) }, { v: 'savepeek', t: '写回当前文件', sub: '⌘S' }, { v: 'revertfile', t: '还原这次改动', sub: peekFileCaption(focusFile) }] : []),
    ...(canTrashHere ? [{ v: 'trash', t: '扔掉这份文件', sub: peekFileCaption(focusFile) }] : []),
    ...(canDuplicateHere ? [{ v: 'duplicate', t: '复制一份', sub: peekFileCaption(focusFile) }] : []),
    ...(canCommitHere ? [{ v: 'commitfiles', t: '记下这次改动', sub: defaultCommitMessage(commitDraft ?? (sessionView.title || activeSummary?.title || '')) }] : []),
    ...(canPushHere ? [{ v: 'push', t: '推到远端', sub: 'git push' }] : []),
    ...(canPullHere ? [{ v: 'pull', t: '拉回远端', sub: '只快进，不改历史' }] : []),
    ...(canExportHere ? [{ v: 'exporttalk', t: '记下这次对话', sub: exportFileName(sessionView.title || activeSummary?.title || '') }] : []),
    ...(canImportHere ? [{ v: 'importtalk', t: '接回记下的对话', sub: importTalkName(focusFile) || '会话目录里最近记下的' }] : []),
    ...(canCopyTalkHere ? [{ v: 'copytalk', t: '复制这次对话', sub: '整段对话进剪贴板' }] : []),
    ...(canPrintTalkHere ? [{ v: 'printtalk', t: '打印这次对话', sub: '系统打印对话框' }] : []),
    ...(canHideHere ? [{ v: 'hidesecrets', t: hideSecretsOn ? '显示密钥' : '藏住密钥', sub: hideSecretsOn ? '现在藏着' : '只藏显示' }] : []),
    ...(canOpenAtLoginHere ? [{ v: 'openatlogin', t: openAtLoginLabel(openAtLogin), sub: openAtLogin ? '现在开机就开' : '登录后打开' }] : []),
    ...(canHotkeyHere ? [{ v: 'hotkey', t: globalHotkeyLabel(globalHotkey), sub: globalHotkey ? '现在 Alt+Space' : 'Alt+Space 唤出窗口' }] : []),
    ...(canAlwaysOnTopHere ? [{ v: 'alwaysontop', t: alwaysOnTopLabel(alwaysOnTop), sub: alwaysOnTop ? '现在钉着' : '盖过别的窗口' }] : []),
    ...(canAllSpacesHere ? [{ v: 'allspaces', t: allSpacesLabel(allSpaces), sub: allSpaces ? '现在每个桌面都在' : '切桌面也带着' }] : []),
    ...(canProtectHere ? [{ v: 'protect', t: contentProtectionLabel(contentProtection), sub: contentProtection ? '现在分享时是黑的' : '录屏和分享里藏住' }] : []),
    ...(canDoneChimeHere ? [{ v: 'donechime', t: doneChimeLabel(doneChimeOn), sub: doneChimeOn ? '现在跑完会响' : '跑完不响' }] : []),
    ...(canOpenLogsHere ? [{ v: 'openlogs', t: openLogsLabel(), sub: '本机日志目录' }] : []),
    ...(canOpenA11yHere ? [{ v: 'opena11y', t: openAccessibilityLabel(), sub: '系统隐私设置' }] : []),
    ...(canRelaunchHere ? [{ v: 'relaunch', t: relaunchLabel(), sub: '整进程重来' }] : []),
    ...(canExtraHere ? [{ v: 'extra', t: extraWindowLabel(), sub: '并排看另一条' }] : []),
    ...(canEmojiHere ? [{ v: 'emoji', t: emojiLabel(), sub: '写进输入框' }] : []),
    ...(canClearCacheHere ? [{ v: 'clearcache', t: clearCacheLabel(), sub: '网页缓存，不清会话' }] : []),
    ...(canLockHere ? [{ v: 'applock', t: lockLabel(appLocked), sub: appLocked ? '触控 ID 解锁' : '锁屏或走开后要解锁' }] : []),
    ...(canCliHere ? [{ v: 'cliinstall', t: installCliLabel(cliInstalled), sub: cliInstalled ? '终端里打 leocodebox' : '终端打开当前目录' }] : []),
    ...(canAppsHere ? [{ v: 'appfolder', t: moveToApplicationsLabel(inApplications), sub: inApplications ? '现在在程序文件夹' : '从下载挪进去' }] : []),
    ...(canCheckUpdateHere ? [{ v: 'checkup', t: checkUpdateLabel(updateState), sub: updateState?.latestVersion ? `现在 ${updateState.latestVersion}` : '看有没有新版本' }] : []),
    { v: 'followsys', t: followSystemLabel(themeMode), sub: themeMode === 'system' ? '现在跟着 macOS' : '跟着 macOS 明暗' },
    ...(canDictateHere ? [{ v: 'dictate', t: dictating ? '停住' : '对着说', sub: dictating ? '正在听' : '写进输入框' }] : []),
    ...(canSearchHere ? [{ v: 'searchcwd', t: '在目录里搜', sub: activeSummary?.cwd || '会话目录' }] : []),
    ...(canShowSessionLog(active?.machine) ? [{ v: 'log', t: '最近提交', sub: activeSummary?.cwd || '会话目录' }] : []),
    ...(canApplyHere ? [{ v: 'apply', t: '贴上补丁', sub: '剪贴板里的 unified diff' }] : []),
    ...(canPackHere ? [{ v: 'pack', t: '带走这次改动', sub: '打成一份 zip' }] : []),
    ...(canUnpackHere ? [{ v: 'unpack', t: '解开这份 zip', sub: unpackZipName(focusFile) || '会话目录里最近的 zip' }] : []),
    ...(canSeedHere ? [{ v: 'seed', t: '建一个文件', sub: seedName.trim() || '剪贴板有字就写进去' }] : []),
    ...(canMkdirHere ? [{ v: 'mkdir', t: '建一个文件夹', sub: folderName.trim() || '写在这个会话目录里' }] : []),
    ...(canBranchHere ? [{ v: 'branch', t: '开这条分支', sub: sanitizeBranchName(branchName) }] : []),
    ...(canInitHere ? [{ v: 'init', t: '做成仓库', sub: 'git init' }] : []),
    ...(canMergeHere ? [{ v: 'merge', t: '并到现在这条', sub: branchName.trim() || '写要并过来的分支' }] : []),
    ...(canMoveHere ? [{ v: 'move', t: '挪进这个文件夹', sub: moveDest.trim() || '空的就是挪回目录根上' }] : []),
    ...(canMentionLast ? [{ v: 'lastreply', t: '带上上一句', sub: lastReply.slice(0, 40) }] : []),
    ...(canCopyLast ? [{ v: 'copyreply', t: '复制刚说的', sub: lastReply.slice(0, 40) }] : []),
    ...(canSpeakLast ? [{ v: 'speaklast', t: '读出刚说的', sub: lastReply.slice(0, 40) }] : []),
    ...(canRetryLast ? [{ v: 'retrylast', t: '再发上一句', sub: lastPrompt.slice(0, 40) }] : []),
    ...(canEditLast ? [{ v: 'editlast', t: '改上一句', sub: lastPrompt.slice(0, 40) }] : []),
    ...(canRewindHere ? [{ v: 'rewind', t: rewindLastTurnLabel(), sub: lastPrompt.slice(0, 40) }] : []),
    ...(canMentionTool ? [{ v: 'lasttool', t: '带上刚打出来的', sub: lastTool.slice(0, 40) }] : []),
    ...(canOpenWritten ? [{ v: 'lastwrite', t: '打开刚写的', sub: peekFileCaption(lastWritten) }] : []),
    ...(canJumpFail ? [{ v: 'lastfail', t: '看刚失败的', sub: lastFail && lastFail.k === 'edit' ? peekFileCaption(lastFail.file) : lastFail && lastFail.k === 'tool' ? (lastFail.preview || lastFail.tool) : '跳到那一行' }] : []),
    ...(canOpenRead ? [{ v: 'lastread', t: '打开刚读的', sub: peekFileCaption(lastRead) }] : []),
    ...(activeSummary?.cwd?.trim() ? [{ v: 'cwd', t: '复制目录', sub: activeSummary.cwd }] : []),
    ...(canRenameSession(active?.machine) ? [{ v: 'rename', t: '改标题', sub: sessionView.title || activeSummary?.title || '给这条会话起个名字' }] : []),
    ...(canSetSessionRule(active?.machine) ? [{ v: 'rule', t: '这条会话的规矩', sub: (sessionView.rule || activeSummary?.rule || '之后每轮都会带着').split('\n')[0] }] : []),
    ...(canCwdRuleHere ? [{ v: 'cwdrule', t: '这个目录的规矩', sub: (sessionView.cwdRule || activeSummary?.cwd_rule || '同一目录新开也会带着').split('\n')[0] }] : []),
    ...((sessionView.title || activeSummary?.title || '').trim() ? [{ v: 'title', t: '复制标题', sub: (sessionView.title || activeSummary?.title || '').trim() }] : []),
    ...(canResumeHere ? [{ v: 'resume', t: '接着这条会话', sub: '同一条上下文' }] : []),
    ...(canFollowUp && draft.trim() ? [{ v: 'follow', t: '接着（排队）', sub: '等这轮说完' }] : []),
    ...(canFollowUp && queuedFollowUps.length ? [{ v: 'clearq', t: '取消排队', sub: `${queuedFollowUps.length} 句` }] : []),
    ...(canDrive ? [] : [{ v: 'continue', t: '在同一目录新开', sub: '新开会话' }]),
    { v: 'compact', t: '压缩这条会话', sub: 'pi compact' }, { v: 'stop', t: '停止', sub: '进程组一起收' },
    ...(canAbortTurnHere ? [{ v: 'abortturn', t: abortTurnLabel(), sub: '这一轮停，进程还在' }] : []),
    ...(canApproveAll ? [{ v: 'approveall', t: approveAllLabel(), sub: `${pendingIds.length} 条待批` }] : []),
    ...(canDenyAll ? [{ v: 'denyall', t: denyAllLabel(), sub: `${denyIds.length} 条待批` }] : []),
    ...(canHaltBusy ? [{ v: 'halt', t: '停掉正在跑的', sub: '本机正在跑的全部停掉' }] : []),
    ...(canForgetEnded ? [{ v: 'forgetended', t: '清掉已经结束的', sub: '钉住的和进行中的不动' }] : []),
    ...(canHere ? [{ v: 'here', t: '这个目录的会话', sub: sameCwdPickerHint(herePeers.length) }] : []),
    ...(canPulse ? [{ v: 'pulse', t: '这条聊了多少', sub: pulseLabel }] : []),
    ...(canFork ? [{ v: 'fork', t: '从这里分一条', sub: forkTitle(sessionView.title || activeSummary?.title) }] : []),
    ...(canLinks ? [{ v: 'links', t: '打开对话里的链接', sub: talkLinkPickerHint(talkLinks.length) }] : []),
    ...(canRecallHere ? [{ v: 'recall', t: '找回来', sub: '从左栏拿掉的会话' }] : []),
    ...(active ? [{ v: 'pin', t: sessionIsPinned(pinnedKeys, active.machine, active.id) ? '取消钉住' : '钉在左栏上面', sub: sessionView.title || activeSummary?.title || '' }] : []),
    ...(activeSummary && sessionCanForget(activeSummary.status) ? [{ v: 'forget', t: '从左栏拿掉', sub: active?.machine === 'local' ? '不再召回' : '只藏在这台 Mac' }] : []),
  ], (v) => {
    if (v === 'compact') void compact();
    else if (v === 'follow') void followUp();
    else if (v === 'clearq') clearFollowUps();
    else if (v === 'winbind' || v === 'winclick') openWindowOp();
    else if (v === 'winread') readBoundField();
    else if (v === 'stop') void stop();
    else if (v === 'abortturn') void abortTurn();
    else if (v === 'approveall') void approveAllPending();
    else if (v === 'denyall') void denyAllPending();
    else if (v === 'halt') void haltBusy();
    else if (v === 'forgetended') void forgetEnded();
    else if (v === 'recall') void openRecall();
    else if (v === 'here') openHere();
    else if (v === 'pulse') showPulse();
    else if (v === 'fork') void forkHere();
    else if (v === 'importtalk') void importTalk();
    else if (v === 'links') openTalkLink();
    else if (v === 'speaklast') speakLast();
    else if (v === 'resume') resumeHere();
    else if (v === 'continue') continueHere();
    else if (v === 'finder') void revealCwd();
    else if (v === 'termapp') void openCwdTerm();
    else if (v === 'dropfile') void pickIntoSession();
    else if (v === 'dropshot') void pasteShot();
    else if (v === 'openfile') void openFocusFile();
    else if (v === 'savepeek') void savePeek();
    else if (v === 'revertfile') void revertFile();
    else if (v === 'commitfiles') void commitFiles();
    else if (v === 'push') void pushRepo();
    else if (v === 'pull') void pullRepo();
    else if (v === 'exporttalk') void exportTalk();
    else if (v === 'copytalk') void copyTalk();
    else if (v === 'printtalk') void printTalk();
    else if (v === 'hidesecrets') toggleHideSecrets();
    else if (v === 'openatlogin') void toggleOpenAtLogin();
    else if (v === 'hotkey') void toggleGlobalHotkey();
    else if (v === 'alwaysontop') void toggleAlwaysOnTop();
    else if (v === 'allspaces') void toggleAllSpaces();
    else if (v === 'protect') void toggleContentProtection();
    else if (v === 'donechime') toggleDoneChime();
    else if (v === 'openlogs') void openLogsHere();
    else if (v === 'opena11y') void openA11yHere();
    else if (v === 'relaunch') void relaunchHere();
    else if (v === 'extra') void extraHere();
    else if (v === 'emoji') void emojiHere();
    else if (v === 'clearcache') void clearCacheHere();
    else if (v === 'applock') void lockHere();
    else if (v === 'cliinstall') void cliHere();
    else if (v === 'appfolder') void appsHere();
    else if (v === 'checkup') void checkUpdateHere();
    else if (v === 'followsys') followSystemHere();
    else if (v === 'dictate') dictateHere();
    else if (v === 'searchcwd') openSearch();
    else if (v === 'log') openLog();
    else if (v === 'apply') void applyPatch();
    else if (v === 'pack') void packChanges();
    else if (v === 'unpack') void unpackZip();
    else if (v === 'seed') void seedFile();
    else if (v === 'mkdir') void mkdirFolder();
    else if (v === 'branch') void switchBranch();
    else if (v === 'init') void initRepo();
    else if (v === 'merge') void mergeBranch();
    else if (v === 'move') void moveFile();
    else if (v === 'trash') void trashFile();
    else if (v === 'duplicate') void duplicateFile();
    else if (v === 'lastreply') mentionLast();
    else if (v === 'copyreply') void copyLastReply();
    else if (v === 'retrylast') void retryLast();
    else if (v === 'editlast') editLastPrompt();
    else if (v === 'rewind') void rewindLast();
    else if (v === 'lasttool') mentionTool();
    else if (v === 'lastwrite') openLastWritten();
    else if (v === 'lastfail') jumpLastFail();
    else if (v === 'lastread') openLastRead();
    else if (v === 'cwd') void copyCwd();
    else if (v === 'rename') beginRename();
    else if (v === 'rule') beginRule();
    else if (v === 'cwdrule') beginCwdRule();
    else if (v === 'title') void copyTitle();
    else if (v === 'find') { setFlowFind((cur) => ({ ...cur, open: true })); window.setTimeout(() => { flowFindRef.current?.focus(); flowFindRef.current?.select(); }, 0); }
    else if (v === 'findhit') void copyFindHit();
    else if (v === 'pin' && active) togglePin(active);
    else if (v === 'forget' && active) void forgetSession(active);
    else if (v) setDrawer(v as DrawerKind);
  });

  // -- 键盘 ------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => ({ open: !p.open, query: '', index: 0 })); setPicker(null); return; }
      if (e.key === 'Escape') {
        if (titleEditing) { setTitleEditing(false); setTitleDraft(null); return; }
        if (ruleEditing) { setRuleEditing(false); setRuleDraft(null); return; }
        if (cwdRuleEditing) { setCwdRuleEditing(false); setCwdRuleDraft(null); return; }
        if (picker) { setPicker(null); return; }
        if (palette.open) { setPalette({ open: false, query: '', index: 0 }); return; }
        if (menu) { setMenu(null); return; }
        if (flowFind.open) { setFlowFind({ open: false, query: '', index: 0 }); return; }
        if (windowOp) { setWindowOp(null); return; }
        if (drawer) { setDrawer(null); return; }
        if (newBox) { setNewBox(null); return; }
        const first = sessionView.pendingApprovals.values().next().value as (FlowRow & { k: 'ap' }) | undefined;
        if (first?.choices.includes('deny')) { e.preventDefault(); void approve(first.approvalId, 'deny'); }
        return;
      }
      if (palette.open || picker) return;
      if (!meta && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement !== taRef.current) {
        if (flowFind.open) {
          e.preventDefault();
          stepFind(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        const list = allSessions.filter((x) => matchesFilter(x.s) || Boolean(active && x.machine === active.machine && x.s.session_id === active.id));
        const current = list.findIndex((x) => active && x.machine === active.machine && x.s.session_id === active.id);
        const next = nextSessionIndex(list.length, current, e.key === 'ArrowDown' ? 1 : -1);
        if (next >= 0 && list[next]) { e.preventDefault(); openSession({ machine: list[next].machine, id: list[next].s.session_id }); }
        return;
      }
      if (meta && e.key === 'Enter') {
        const ta = taRef.current;
        if (document.activeElement === ta && (draft.trim())) { e.preventDefault(); void send(); return; }
        if (document.activeElement !== ta) { e.preventDefault(); approveFirstPending(); }
        return;
      }
      if (meta && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setView((['home', 'devices', 'channels'] as View[])[Number(e.key) - 1]); return; }
      if (meta && e.key === ',') { e.preventDefault(); setView('settings'); return; }
      if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); beginLocalNew(); return; }
      if (meta && e.key.toLowerCase() === 's' && isPeekDrawer(drawer)) { e.preventDefault(); void savePeek(); return; }
      if (meta && e.key.toLowerCase() === 'g' && flowFind.open) {
        e.preventDefault();
        stepFind(e.shiftKey ? -1 : 1);
        return;
      }
      if (meta && e.key.toLowerCase() === 'c' && flowFind.open) {
        const input = flowFindRef.current;
        if (input && document.activeElement === input && input.selectionStart !== input.selectionEnd) return;
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        void copyFindHit();
        return;
      }
      if (meta && e.key.toLowerCase() === 'f' && view === 'home' && active) {
        e.preventDefault();
        setFlowFind((cur) => ({ ...cur, open: true }));
        window.setTimeout(() => { flowFindRef.current?.focus(); flowFindRef.current?.select(); }, 0);
        return;
      }
      if (meta && view === 'home' && ['t', 'd', 'e', 'b'].includes(e.key.toLowerCase())) { e.preventDefault(); setDrawer(({ t: 'term', d: 'diff', e: 'files', b: 'browser' } as Record<string, DrawerKind>)[e.key.toLowerCase()]); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [palette.open, picker, menu, drawer, newBox, draft, send, approveFirstPending, view, sessionView.pendingApprovals, approve, allSessions, matchesFilter, active, openSession, beginLocalNew, flowFind.open, windowOp, stepFind, copyFindHit, savePeek, titleEditing, ruleEditing, cwdRuleEditing]);

  // -- 命令面板 ---------------------------------------------------------------
  type Command = { g: string; t: string; k: string; run: () => void };
  const commands = useMemo<Command[]>(() => [
    { g: '会话', t: '新会话…', k: '⌘N', run: beginLocalNew },
    ...groups.filter((g) => g.online && g.id !== 'local').map((g) => ({ g: '会话', t: `在 ${g.name} 上新会话`, k: g.role, run: () => { setNewBox({ open: true, machine: g.id }); setView('home'); } })),
    { g: '审批', t: '批准最近一条待批', k: '⌘↩', run: approveFirstPending },
    ...(canApproveAll ? [{ g: '审批', t: approveAllLabel(), k: `${pendingIds.length} 条待批`, run: () => { void approveAllPending(); } }] : []),
    ...(canDenyAll ? [{ g: '审批', t: denyAllLabel(), k: `${denyIds.length} 条待批`, run: () => { void denyAllPending(); } }] : []),
    ...configuredModels.map((m) => ({ g: '模型', t: `切换模型:${prettyModelName(m.id, m.name)}`, k: m.providerName, run: () => void setModel(m.provider, m.id) })),
    ...(['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => ({ g: '审批策略', t: POLICY_LABEL[p], k: '本会话', run: () => void setPolicy(p) })),
    ...THINKING_LEVELS.map((level) => ({ g: '思考', t: `思考深度:${THINKING_LABEL[level]}`, k: level, run: () => void setThinking(level) })),
    { g: '这条会话', t: '在这条会话里找', k: '⌘F', run: () => { if (!active) return; setView('home'); setFlowFind((cur) => ({ ...cur, open: true })); window.setTimeout(() => { flowFindRef.current?.focus(); flowFindRef.current?.select(); }, 0); } },
    { g: '这条会话', t: '下一条查找', k: '⌘G', run: () => { if (!active) return; setView('home'); stepFind(1); } },
    { g: '这条会话', t: '复制当前命中', k: '⌘C', run: () => { if (!active) return; void copyFindHit(); } },
    ...(canResumeHere ? [{ g: '这条会话', t: '接着这条会话', k: '同一条上下文', run: resumeHere }] : []),
    ...(canFollowUp && draft.trim() ? [{ g: '这条会话', t: '接着（排队）', k: '等这轮说完', run: () => void followUp() }] : []),
    ...(canFollowUp && queuedFollowUps.length ? [{ g: '这条会话', t: '取消排队', k: `${queuedFollowUps.length} 句`, run: clearFollowUps }] : []),
    { g: '这条会话', t: '在同一目录新开', k: '新开会话', run: continueHere },
    ...(canRenameSession(active?.machine) ? [{ g: '这条会话', t: '改标题', k: sessionView.title || activeSummary?.title || '', run: beginRename }] : []),
    ...(canSetSessionRule(active?.machine) ? [{ g: '这条会话', t: '这条会话的规矩', k: (sessionView.rule || activeSummary?.rule || '').split('\n')[0], run: beginRule }] : []),
    ...(canCwdRuleHere ? [{ g: '这条会话', t: '这个目录的规矩', k: (sessionView.cwdRule || activeSummary?.cwd_rule || '').split('\n')[0], run: beginCwdRule }] : []),
    { g: '这条会话', t: '复制标题', k: sessionView.title || activeSummary?.title || '', run: () => void copyTitle() },
    { g: '这条会话', t: '复制目录', k: activeSummary?.cwd || '', run: () => void copyCwd() },
    ...(active?.machine === 'local' && activeSummary?.cwd?.trim() ? [{ g: '这条会话', t: '在 Finder 打开', k: activeSummary.cwd, run: () => void revealCwd() }, { g: '这条会话', t: '在终端打开', k: activeSummary.cwd, run: () => void openCwdTerm() }] : []),
    ...(boundWindowChipKind(active?.machine ?? '', windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window))) === 'raise' ? [{ g: '这条会话', t: '读回窗口里的字', k: windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window)), run: () => readBoundField() }] : []),
    { g: '这条会话', t: '压缩这条会话', k: 'pi compact', run: () => void compact() },
    { g: '这条会话', t: '停止', k: '', run: () => void stop() },
    ...(canAbortTurnHere ? [{ g: '这条会话', t: abortTurnLabel(), k: '这一轮停，进程还在', run: () => { void abortTurn(); } }] : []),
    ...(canHaltBusy ? [{ g: '本机', t: '停掉正在跑的', k: '全部', run: () => void haltBusy() }] : []),
    ...stoppableLocalSessions(allSessions).map((row) => ({
      g: '本机' as const,
      t: '停掉这条',
      k: row.s?.title || row.s?.session_id || '',
      run: () => void stopTarget({ machine: row.machine || 'local', id: row.s!.session_id! }, row.s?.title),
    })),
    ...(canForgetEnded ? [{ g: '本机', t: '清掉已经结束的', k: '终态', run: () => void forgetEnded() }] : []),
    ...(canHere ? [{ g: '这条会话', t: '这个目录的会话', k: sameCwdPickerHint(herePeers.length), run: () => openHere() }] : []),
    ...(canPulse ? [{ g: '这条会话', t: '这条聊了多少', k: pulseLabel, run: showPulse }] : []),
    ...(canFork ? [{ g: '这条会话', t: '从这里分一条', k: forkTitle(sessionView.title || activeSummary?.title), run: () => void forkHere() }] : []),
    ...(canLinks ? [{ g: '这条会话', t: '打开对话里的链接', k: talkLinkPickerHint(talkLinks.length), run: () => openTalkLink() }] : []),
    ...(canRecallHere ? [{ g: '本机', t: '找回来', k: '拿掉的', run: () => void openRecall() }] : []),
    ...(active ? [{ g: '这条会话', t: sessionIsPinned(pinnedKeys, active.machine, active.id) ? '取消钉住' : '钉在左栏上面', k: '', run: () => togglePin(active) }] : []),
    ...(active && activeSummary && sessionCanForget(activeSummary.status) ? [{ g: '这条会话', t: '从左栏拿掉', k: '', run: () => void forgetSession(active) }] : []),
    { g: '这条会话', t: '用默认程序打开', k: focusFile || '', run: () => void openFocusFile() },
    { g: '这条会话', t: '写回当前文件', k: '⌘S', run: () => void savePeek() },
    ...(canRevertSessionFile(active?.machine, focusFile) ? [{ g: '这条会话', t: '还原这次改动', k: focusFile || '', run: () => void revertFile() }] : []),
    ...(canTrashHere ? [{ g: '这条会话', t: '扔掉这份文件', k: focusFile || '', run: () => void trashFile() }] : []),
    ...(canDuplicateHere ? [{ g: '这条会话', t: '复制一份', k: focusFile || '', run: () => void duplicateFile() }] : []),
    ...(canCommitHere ? [{ g: '这条会话', t: '记下这次改动', k: defaultCommitMessage(commitDraft ?? (sessionView.title || activeSummary?.title || '')), run: () => void commitFiles() }] : []),
    ...(canPushHere ? [{ g: '这条会话', t: '推到远端', k: 'push', run: () => void pushRepo() }] : []),
    ...(canPullHere ? [{ g: '这条会话', t: '拉回远端', k: 'pull', run: () => void pullRepo() }] : []),
    ...(canExportHere ? [{ g: '这条会话', t: '记下这次对话', k: exportFileName(sessionView.title || activeSummary?.title || ''), run: () => void exportTalk() }] : []),
    ...(canImportHere ? [{ g: '这条会话', t: '接回记下的对话', k: importTalkName(focusFile) || '最近记下的', run: () => void importTalk() }] : []),
    ...(canCopyTalkHere ? [{ g: '这条会话', t: '复制这次对话', k: '剪贴板', run: () => void copyTalk() }] : []),
    ...(canPrintTalkHere ? [{ g: '这条会话', t: '打印这次对话', k: '打印', run: () => void printTalk() }] : []),
    ...(canHideHere ? [{ g: '这条会话', t: hideSecretsOn ? '显示密钥' : '藏住密钥', k: hideSecretsOn ? '现在藏着' : '只藏显示', run: toggleHideSecrets }] : []),
    ...(canDictateHere ? [{ g: '这条会话', t: dictating ? '停住' : '对着说', k: dictating ? '正在听' : '写进输入框', run: dictateHere }] : []),
    ...(canSearchHere ? [{ g: '这条会话', t: '在目录里搜', k: activeSummary?.cwd || '', run: openSearch }] : []),
    ...(canShowSessionLog(active?.machine) ? [{ g: '这条会话', t: '最近提交', k: activeSummary?.cwd || '', run: openLog }] : []),
    ...(canApplyHere ? [{ g: '这条会话', t: '贴上补丁', k: '剪贴板', run: () => void applyPatch() }] : []),
    ...(canPackHere ? [{ g: '这条会话', t: '带走这次改动', k: 'zip', run: () => void packChanges() }] : []),
    ...(canUnpackHere ? [{ g: '这条会话', t: '解开这份 zip', k: unpackZipName(focusFile) || 'zip', run: () => void unpackZip() }] : []),
    ...(canSeedHere ? [{ g: '这条会话', t: '建一个文件', k: '新建', run: () => void seedFile() }] : []),
    ...(canMkdirHere ? [{ g: '这条会话', t: '建一个文件夹', k: folderName.trim() || '新建', run: () => void mkdirFolder() }] : []),
    ...(canBranchHere ? [{ g: '这条会话', t: '开这条分支', k: sanitizeBranchName(branchName), run: () => void switchBranch() }] : []),
    ...(canInitHere ? [{ g: '这条会话', t: '做成仓库', k: 'init', run: () => void initRepo() }] : []),
    ...(canMergeHere ? [{ g: '这条会话', t: '并到现在这条', k: branchName.trim() || '写要并过来的分支', run: () => void mergeBranch() }] : []),
    ...(canMoveHere ? [{ g: '这条会话', t: '挪进这个文件夹', k: moveDest.trim() || focusFile || '', run: () => void moveFile() }] : []),
    ...(canMentionLast ? [{ g: '这条会话', t: '带上上一句', k: lastReply.slice(0, 40), run: mentionLast }] : []),
    ...(canCopyLast ? [{ g: '这条会话', t: '复制刚说的', k: lastReply.slice(0, 40), run: () => void copyLastReply() }] : []),
    ...(canSpeakLast ? [{ g: '这条会话', t: '读出刚说的', k: lastReply.slice(0, 40), run: speakLast }] : []),
    ...(canRetryLast ? [{ g: '这条会话', t: '再发上一句', k: lastPrompt.slice(0, 40), run: () => void retryLast() }] : []),
    ...(canEditLast ? [{ g: '这条会话', t: '改上一句', k: lastPrompt.slice(0, 40), run: editLastPrompt }] : []),
    ...(canRewindHere ? [{ g: '这条会话', t: rewindLastTurnLabel(), k: lastPrompt.slice(0, 40), run: () => { void rewindLast(); } }] : []),
    ...(canMentionTool ? [{ g: '这条会话', t: '带上刚打出来的', k: lastTool.slice(0, 40), run: mentionTool }] : []),
    ...(canOpenWritten ? [{ g: '这条会话', t: '打开刚写的', k: peekFileCaption(lastWritten), run: openLastWritten }] : []),
    ...(canJumpFail ? [{ g: '这条会话', t: '看刚失败的', k: lastFail && lastFail.k === 'edit' ? peekFileCaption(lastFail.file) : lastFail && lastFail.k === 'tool' ? (lastFail.preview || lastFail.tool) : '跳到那一行', run: jumpLastFail }] : []),
    ...(canOpenRead ? [{ g: '这条会话', t: '打开刚读的', k: peekFileCaption(lastRead), run: openLastRead }] : []),
    { g: '这条会话', t: '放入文件', k: '拖到输入框', run: () => void pickIntoSession() },
    { g: '这条会话', t: '粘贴截图', k: '⌘V', run: () => void pasteShot() },
    { g: '这条会话', t: '终端', k: '⌘T', run: () => setDrawer('term') }, { g: '这条会话', t: '文件', k: '⌘E', run: () => setDrawer('files') },
    { g: '这条会话', t: '本次改动', k: '⌘D', run: () => setDrawer('diff') }, { g: '这条会话', t: '浏览器', k: '⌘B', run: () => setDrawer('browser') },
    { g: '页面', t: '主控', k: '⌘1', run: () => setView('home') }, { g: '页面', t: '设备', k: '⌘2', run: () => setView('devices') }, { g: '页面', t: '通道', k: '⌘3', run: () => setView('channels') }, { g: '页面', t: '设置', k: '⌘,', run: () => setView('settings') },
    { g: '外观', t: isDarkMode ? '切到亮色' : '切到暗色', k: '', run: toggleDarkMode },
    { g: '外观', t: followSystemLabel(themeMode), k: themeMode === 'system' ? '现在跟着 macOS' : '跟着 macOS 明暗', run: followSystemHere },
    ...(canOpenAtLoginHere ? [{ g: '本机', t: openAtLoginLabel(openAtLogin), k: openAtLogin ? '现在开机就开' : '登录后打开', run: () => void toggleOpenAtLogin() }] : []),
    ...(canHotkeyHere ? [{ g: '本机', t: globalHotkeyLabel(globalHotkey), k: globalHotkey ? '现在 Alt+Space' : 'Alt+Space 唤出窗口', run: () => void toggleGlobalHotkey() }] : []),
    ...(canAlwaysOnTopHere ? [{ g: '本机', t: alwaysOnTopLabel(alwaysOnTop), k: alwaysOnTop ? '现在钉着' : '盖过别的窗口', run: () => void toggleAlwaysOnTop() }] : []),
    ...(canAllSpacesHere ? [{ g: '本机', t: allSpacesLabel(allSpaces), k: allSpaces ? '现在每个桌面都在' : '切桌面也带着', run: () => void toggleAllSpaces() }] : []),
    ...(canProtectHere ? [{ g: '本机', t: contentProtectionLabel(contentProtection), k: contentProtection ? '现在分享时是黑的' : '录屏和分享里藏住', run: () => void toggleContentProtection() }] : []),
    ...(canDoneChimeHere ? [{ g: '本机', t: doneChimeLabel(doneChimeOn), k: doneChimeOn ? '现在跑完会响' : '跑完不响', run: () => toggleDoneChime() }] : []),
    ...(canOpenLogsHere ? [{ g: '本机', t: openLogsLabel(), k: '本机日志目录', run: () => void openLogsHere() }] : []),
    ...(canOpenA11yHere ? [{ g: '本机', t: openAccessibilityLabel(), k: '系统隐私设置', run: () => void openA11yHere() }] : []),
    ...(canRelaunchHere ? [{ g: '本机', t: relaunchLabel(), k: '整进程重来', run: () => void relaunchHere() }] : []),
    ...(canExtraHere ? [{ g: '本机', t: extraWindowLabel(), k: '并排看另一条', run: () => void extraHere() }] : []),
    ...(canEmojiHere ? [{ g: '本机', t: emojiLabel(), k: '写进输入框', run: () => void emojiHere() }] : []),
    ...(canClearCacheHere ? [{ g: '本机', t: clearCacheLabel(), k: '网页缓存，不清会话', run: () => void clearCacheHere() }] : []),
    ...(canLockHere ? [{ g: '本机', t: lockLabel(appLocked), k: appLocked ? '触控 ID 解锁' : '锁屏或走开后要解锁', run: () => void lockHere() }] : []),
    ...(canCliHere ? [{ g: '本机', t: installCliLabel(cliInstalled), k: cliInstalled ? '终端里打 leocodebox' : '终端打开当前目录', run: () => void cliHere() }] : []),
    ...(canAppsHere ? [{ g: '本机', t: moveToApplicationsLabel(inApplications), k: inApplications ? '现在在程序文件夹' : '从下载挪进去', run: () => void appsHere() }] : []),
    ...(canCheckUpdateHere ? [{ g: '本机', t: checkUpdateLabel(updateState), k: updateState?.latestVersion ? `现在 ${updateState.latestVersion}` : '看有没有新版本', run: () => void checkUpdateHere() }] : []),
    ...allSessions.map((x) => ({ g: '跳转', t: `会话:${x.s.title || x.s.session_id}`, k: x.machineName, run: () => openSession({ machine: x.machine, id: x.s.session_id }) })),
  ], [groups, configuredModels, allSessions, approveFirstPending, approveAllPending, denyAllPending, canApproveAll, canDenyAll, pendingIds, denyIds, setModel, setPolicy, setThinking, compact, stop, abortTurn, canAbortTurnHere, stopTarget, haltBusy, canHaltBusy, forgetEnded, canForgetEnded, openRecall, canRecallHere, continueHere, resumeHere, canResumeHere, canFollowUp, queuedFollowUps.length, followUp, clearFollowUps, draft, forgetSession, togglePin, pinnedKeys, active, activeSummary, isDarkMode, toggleDarkMode, themeMode, followSystemHere, openSession, beginLocalNew, copyTitle, beginRename, beginRule, beginCwdRule, canCwdRuleHere, copyCwd, revealCwd, openCwdTerm, readBoundField, copyFindHit, savePeek, revertFile, trashFile, canTrashHere, duplicateFile, canDuplicateHere, mkdirFolder, canMkdirHere, folderName, switchBranch, canBranchHere, branchName, initRepo, canInitHere, mergeBranch, canMergeHere, moveFile, canMoveHere, moveDest, commitFiles, canCommitHere, commitDraft, pushRepo, canPushHere, pullRepo, canPullHere, exportTalk, canExportHere, importTalk, canImportHere, copyTalk, canCopyTalkHere, printTalk, canPrintTalkHere, toggleHideSecrets, canHideHere, hideSecretsOn, toggleOpenAtLogin, canOpenAtLoginHere, openAtLogin, toggleGlobalHotkey, canHotkeyHere, globalHotkey, toggleAlwaysOnTop, canAlwaysOnTopHere, alwaysOnTop, toggleAllSpaces, canAllSpacesHere, allSpaces, toggleContentProtection, canProtectHere, contentProtection, toggleDoneChime, canDoneChimeHere, doneChimeOn, openLogsHere, canOpenLogsHere, openA11yHere, canOpenA11yHere, relaunchHere, canRelaunchHere, extraHere, canExtraHere, emojiHere, canEmojiHere, clearCacheHere, canClearCacheHere, lockHere, canLockHere, appLocked, cliHere, canCliHere, cliInstalled, appsHere, canAppsHere, inApplications, checkUpdateHere, canCheckUpdateHere, updateState, dictateHere, canDictateHere, dictating, canSearchHere, openSearch, openLog, applyPatch, canApplyHere, packChanges, canPackHere, unpackZip, canUnpackHere, seedFile, canSeedHere, mentionLast, canMentionLast, lastReply, copyLastReply, canCopyLast, speakLast, canSpeakLast, retryLast, canRetryLast, lastPrompt, editLastPrompt, canEditLast, rewindLast, canRewindHere, mentionTool, canMentionTool, lastTool, openLastWritten, canOpenWritten, lastWritten, jumpLastFail, canJumpFail, lastFail, openLastRead, canOpenRead, lastRead, openHere, canHere, herePeers, showPulse, canPulse, pulseLabel, forkHere, canFork, openTalkLink, canLinks, talkLinks, openFocusFile, pickIntoSession, pasteShot, sessionView.title, sessionView.rule, sessionView.cwdRule, sessionView.window, stepFind, focusFile]);
  const filteredCommands = useMemo(() => {
    const q = palette.query.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.t} ${c.k} ${c.g}`.toLowerCase().includes(q)) : commands;
  }, [commands, palette.query]);
  const runCommand = (index: number) => { const c = filteredCommands[index]; setPalette({ open: false, query: '', index: 0 }); c?.run(); };

  const pickerItems = useMemo(() => {
    if (!picker) return [] as Array<{ v: string; t: string; sub: string; g: string }>;
    const q = picker.query.trim().toLowerCase();
    if (picker.kind === 'model') {
      const items = configuredModels.length
        ? configuredModels.map((m) => ({
          v: `${m.provider}/${m.id}`,
          t: prettyModelName(m.id, m.name),
          sub: [m.providerName, modelChoiceHint(m), m.reasoning ? '思考' : '', formatContextWindow(m.contextWindow)].filter(Boolean).join(' · '),
          g: m.providerName,
        }))
        : [{ v: '', t: '还没有可用模型', sub: '去设置里登录或录入兼容接口', g: '模型' }];
      return q ? items.filter((it) => `${it.t} ${it.sub} ${it.v}`.toLowerCase().includes(q)) : items;
    }
    if (picker.kind === 'policy') {
      return (['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => ({ v: p, t: POLICY_LABEL[p], sub: '', g: '审批' }));
    }
    if (picker.kind === 'recall') {
      const items = forgotten.map((row) => ({
        v: row.session_id,
        t: row.title || row.session_id,
        sub: row.cwd,
        g: '拿掉的',
      }));
      return q ? items.filter((it) => `${it.t} ${it.sub} ${it.v}`.toLowerCase().includes(q)) : items;
    }
    if (picker.kind === 'here') {
      const items = hereRows.map((row) => ({
        v: row.session_id,
        t: row.title || row.session_id,
        sub: row.cwd,
        g: '这个目录',
      }));
      return q ? items.filter((it) => `${it.t} ${it.sub} ${it.v}`.toLowerCase().includes(q)) : items;
    }
    if (picker.kind === 'link') {
      const items = talkLinks.map((row) => ({
        v: row.url,
        t: row.label,
        sub: row.url,
        g: '链接',
      }));
      return q ? items.filter((it) => `${it.t} ${it.sub}`.toLowerCase().includes(q)) : items;
    }
    return THINKING_LEVELS.map((level) => ({ v: level, t: THINKING_LABEL[level], sub: level, g: '思考' }));
  }, [picker, configuredModels, forgotten, hereRows, talkLinks]);
  const runPicker = (index: number) => {
    const item = pickerItems[index];
    if (!picker || !item) return;
    if (picker.kind === 'model') {
      if (!item.v) { setView('settings'); setPicker(null); return; }
      const i = item.v.indexOf('/');
      void setModel(item.v.slice(0, i), item.v.slice(i + 1));
    } else if (picker.kind === 'policy') void setPolicy(item.v);
    else if (picker.kind === 'recall') { void recallForgotten(item.v); return; }
    else if (picker.kind === 'here') { openHere(item.v); return; }
    else if (picker.kind === 'link') { openTalkLink(item.v); return; }
    else void setThinking(item.v);
    setPicker(null);
  };
  useEffect(() => {
    const list = railListRef.current;
    const on = list?.querySelector('.srow.on') as HTMLElement | null;
    if (!list) return;
    if (!on) { list.style.removeProperty('--pill-y'); list.style.removeProperty('--pill-h'); return; }
    list.style.setProperty('--pill-y', `${on.offsetTop}px`);
    list.style.setProperty('--pill-h', `${on.offsetHeight}px`);
  }, [active, filter, allSessions, newBox, view]);
  useEffect(() => {
    if (!newBox?.open) return;
    railListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [newBox?.open]);
  useEffect(() => {
    if (!composerShouldFocus({
      hasSession: Boolean(active),
      view,
      drawer,
      newBoxOpen: Boolean(newBox?.open),
      paletteOpen: palette.open,
      pickerOpen: Boolean(picker),
      whatsNewOpen: Boolean(whatsNew),
      flowFindOpen: flowFind.open,
      windowOpOpen: Boolean(windowOp),
    })) return;
    taRef.current?.focus({ preventScroll: true });
  }, [active, view, drawer, newBox?.open, palette.open, picker, whatsNew, flowFind.open, windowOp]);

  // -- 渲染 ------------------------------------------------------------------
  const activeGroup = active ? groups.find((g) => g.id === active.machine) ?? null : null;
  const title = sessionView.title || activeSummary?.title || (activeSummary ? '新会话' : '');
  const cwd = activeSummary?.cwd ?? '';
  const boundWindowText = windowBoundLabel(sessionView.window ?? boundWindowFromUnknown(activeSummary?.window));
  const failTexts = sessionFailTexts({
    lastEventText: activeSummary?.last_event?.text,
    rows: sessionView.rows,
  });
  const needsSettings = sessionNeedsSettings(failTexts);
  const needsModelSwitch = composerNeedsModelSwitch(sessionView.model, failTexts);
  const project: Project | null = activeSummary && cwd
    ? { projectId: workspace?.projectId || '', displayName: workspace?.displayName || title || cwd, fullPath: workspace?.fullPath || cwd, path: workspace?.path || cwd }
    : null;
  const editRows = sessionView.rows.filter((r): r is FlowRow & { k: 'edit' } => r.k === 'edit');
  const filePins = mergeFilePins(editRows, sessionArtifacts);
  const remoteCopy = drawer && active?.machine !== 'local' && isRemoteDrawerKind(drawer)
    ? remoteDrawerCopy(drawer, { machineName: machineChipLabel(activeGroup?.name ?? active?.machine) || '远程', cwd })
    : null;
  const drawerTitle = remoteCopy?.title
    ?? (drawer === 'diff' ? `本次改动${editRows.length ? ` · ${editRows.length}` : ''}` : ({ term: '终端', files: '文件', diff: '本次改动', browser: '浏览器' } as const)[drawer ?? 'term']);
  const peekPath = focusFile ? sessionFilePath(cwd || workspace?.fullPath || '', focusFile) : '';
  const canWritePeek = drawer !== 'diff' && peekCanWriteBack({ machine: active?.machine, projectId: workspace?.projectId, path: peekPath, peek: filePeek });
  const peekDirty = canWritePeek && filePeekDraft != null && filePeekDraft !== filePeek;
  const filePeekBlock = filePeek != null ? (
    <div className="local-files-peek-wrap">
      <div className="local-files-peek-head">
        {focusCommit ? <b className="local-files-name">{commits.find((row) => row.hash === focusCommit)?.subject || focusCommit}</b> : peekFileCaption(focusFile) ? <b className="local-files-name">{peekFileCaption(focusFile)}</b> : <span />}
        <span className="local-files-peek-acts">
          {canWritePeek ? <button className="link" type="button" disabled={!peekDirty} onClick={() => { void savePeek(); }}>{peekDirty ? '保存' : '已是最新'}</button> : null}
          {canRevertSessionFile(active?.machine, focusFile) ? <button className="link" type="button" onClick={() => { void revertFile(); }}>还原</button> : null}
          {canTrashHere ? <button className="link dim" type="button" onClick={() => { void trashFile(); }}>扔掉这份文件</button> : null}
          {canDuplicateHere ? <button className="link" type="button" onClick={() => { void duplicateFile(); }}>复制一份</button> : null}
          {canMoveHere ? <button className="link" type="button" onClick={() => { void moveFile(); }}>挪进这个文件夹</button> : null}
          {canOpenSessionPath(active?.machine, peekPath || cwd) ? <button className="link" type="button" onClick={() => { void openFocusFile(); }}>用默认程序打开</button> : null}
          {active?.machine === 'local' && (focusFile || cwd) ? <button className="link" type="button" onClick={() => { void revealFocusFile(); }}>在 Finder 显示</button> : null}
          {canOpenSessionPath(active?.machine, cwd) ? <button className="link" type="button" onClick={() => { void openCwdTerm(); }}>在终端打开</button> : null}
          <button className="link" type="button" onClick={() => { void navigator.clipboard.writeText(filePeekDraft ?? filePeek); toast('已复制正文'); }}>复制正文</button>
        </span>
      </div>
      {canWritePeek ? (
        <textarea className="local-files-peek" value={filePeekDraft ?? filePeek} spellCheck={false}
          onChange={(e) => setFilePeekDraft(e.target.value)} />
      ) : (
        <pre className="local-files-peek">{filePeek}</pre>
      )}
    </div>
  ) : null;

  return (
    <div className={`leo2 ${isDarkMode ? '' : 'light'}`}>
      {/* 顶条:窗口隐藏标题栏下,BrowserView 顶部 ~42px 收不到真实鼠标事件(实测),
          所以这里只放"看"的东西:标题 + 状态。所有能点的都在左栏。 */}
      <header className="titlebar glass">
        <div />
        <div className="tb-title">
          {view === 'home'
            ? (() => {
                const tb = titlebarHomeCopy({ hasSession: Boolean(activeSummary), machineName: activeGroup?.name ?? active?.machine, cwd });
                return <><b>{tb.title}</b>{tb.sub ? <span className="tb-sub mono">{tb.sub}</span> : null}</>;
              })()
            : <b>{{ devices: '设备', channels: '通道', settings: '设置' }[view]}</b>}
        </div>
        <div className="tb-right">
          <span className="tb-status"><span className={`dot ${loadError ? 'err' : fleetHealth.stale ? 'need' : 'ok'}`} /><span>{loadError ? `本机服务:${loadError}` : `本机服务正常${fleet?.configured ? (fleetHealth.stale ? ' · 远程状态待确认' : ` · 远程 ${groups.filter((g) => g.id !== 'local' && g.online).length} 台在线`) : ''}`}</span></span>
        </div>
      </header>

      <div className="body">
        {(
          <aside className="rail" aria-label="会话">
            <div className="rail-top">
              <nav className="topnav" aria-label="主导航">
                {([['home', '主控', '⌘1'], ['devices', '设备', '⌘2'], ['channels', '通道', '⌘3'], ['settings', '设置', '⌘,']] as Array<[View, string, string]>).map(([v, label, k]) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={k}>{label}</button>
                ))}
              </nav>
              <button className="btn-new" onClick={beginLocalNew}><span>+ 新会话</span><kbd>⌘N</kbd></button>
              <div className="chips">
                {([['all', '全部'], ['active', '进行中'], ['need', '需要你'], ['err', '失败'], ['history', '历史']] as Array<[Filter, string]>).map(([f, label]) => (
                  <button key={f} className={`chip-f ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{label}<i>{counts[f]}</i></button>
                ))}
              </div>
              <input className="rail-find" type="search" value={railQuery} onChange={(e) => setRailQuery(e.target.value)} placeholder="找会话或说过的话" aria-label="找会话或说过的话" />
            </div>
            <div className="rail-list" ref={railListRef}>
              <div className="srow-pill" aria-hidden />
              {newBox?.open && (
                <NewSessionBox machine={newBox.machine} groups={groups} models={configuredModels} defaultCwd={newBox.cwd || activeSummary?.cwd || local?.home || '~'} initialPrompt={newBox.prompt} initialModel={newBox.model} recentCwds={recentCwds} busy={busy}
                  onCancel={() => setNewBox(null)} onCreate={(input) => void createSession(input)} onOpenSettings={() => { setNewBox(null); setView('settings'); }} onPickFolder={pickFolder} />
              )}
              {(() => {
                const visible = groups.map((g) => ({ g, ss: keepActiveSession(g.sessions, (s) => matchesFilter(s) && (sessionMatchesQuery(s, railQuery) || (g.id === 'local' && talkIds.includes(s.session_id))), active?.machine === g.id ? active.id : null).sort((a, b) => comparePinnedFirst(pinnedSet.has(sessionKey(g.id, a.session_id)), pinnedSet.has(sessionKey(g.id, b.session_id)), (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.updated_at - a.updated_at)) })).filter((x) => x.ss.length > 0);
                if (!local && !loadError) return <div className="rail-empty">连接本机服务…</div>;
                if (visible.length === 0) return <div className="rail-empty">{railQuery.trim() ? `没有匹配「${railQuery.trim()}」的会话` : filter === 'all' ? '还没有会话 —— 点上面「+ 新会话」开始' : `没有${({ active: '进行中', need: '需要你', err: '失败', history: '历史' } as Record<string, string>)[filter]}的会话`}</div>;
                const historyHint = hiddenHistoryHint(filter, counts.history, Boolean(activeSummary && isHistoryStatus(activeSummary.status)));
                return (
                  <>
                    {visible.map(({ g, ss }) => (
                  <div key={g.id}>
                    <div className="grp-h"><span className={`dot ${g.stale ? 'need' : g.online ? 'ok' : 'off'}`} /><b title={g.name}>{machineChipLabel(g.name)}</b><span className="role">{g.stale ? '待确认' : g.role}</span><span className="cnt">{ss.length}</span></div>
                    {ss.map((s) => {
                      const on = active?.machine === g.id && active.id === s.session_id;
                      const dot = statusDotForSession(s);
                      return (
                        <button key={s.session_id} className={`srow ${on ? 'on' : ''}`} onClick={() => openSession({ machine: g.id, id: s.session_id })}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const pinned = pinnedSet.has(sessionKey(g.id, s.session_id));
                            setMenu({
                              x: Math.min(e.clientX, window.innerWidth - 270),
                              y: Math.min(e.clientY + 4, window.innerHeight - 80),
                              items: [
                                { v: 'pin', t: pinned ? '取消钉住' : '钉在左栏上面', sub: s.title || '新会话' },
                                ...(canStopSession(g.id, s.status) ? [{ v: 'stopone', t: '停掉这条', sub: s.title || '正在跑' }] : []),
                                ...(sessionCanForget(s.status) ? [{ v: 'forget', t: '从左栏拿掉', sub: g.id === 'local' ? '不再召回' : '只藏在这台 Mac' }] : []),
                              ],
                              onPick: (v) => {
                                if (v === 'pin') togglePin({ machine: g.id, id: s.session_id });
                                if (v === 'stopone') void stopTarget({ machine: g.id, id: s.session_id }, s.title);
                                if (v === 'forget') void forgetSession({ machine: g.id, id: s.session_id });
                              },
                            });
                          }}>
                          <span className={`dot ${dot === 'idle' ? '' : dot}${dot === 'need' ? ' ping' : ''}`} />
                          <div style={{ minWidth: 0 }}>
                            <div className="srow-t"><span>{s.title || '新会话'}</span><span className="srow-m">{pinnedSet.has(sessionKey(g.id, s.session_id)) ? '钉 · ' : ''}{prettyModelName(s.model)}</span></div>
                            <div className={`srow-l ${dot === 'need' ? 'need' : dot === 'err' ? 'err' : ''}`}>{lastLine(s)}</div>
                          </div>
                          <span className="srow-time">{relativeTime(s.updated_at)}</span>
                        </button>
                      );
                    })}
                  </div>
                    ))}
                    {historyHint ? <button className="rail-more" type="button" onClick={() => setFilter('history')}>{historyHint}</button> : null}
                  </>
                );
              })()}
            </div>
            <div className="rail-foot">
              <button className="tb-btn" onClick={() => setPalette({ open: true, query: '', index: 0 })} title="命令面板">⌘K 命令</button>
              <button className="tb-btn" onClick={toggleDarkMode} title="切换明暗">{isDarkMode ? '亮色' : '暗色'}</button>
            </div>
          </aside>
        )}

        <main className={`main ${drawer ? 'dim' : ''}`}>
          {view === 'home' && (!activeSummary ? (
            <div className="empty-main">{(() => {
              const empty = homeEmptyCopy({ loadError, modelCount: configuredModels.length, providersReady: providers !== null });
              return (
                <>
                  <b>{empty.title}</b>
                  <span>{empty.hint}</span>
                  {empty.action === 'retry' ? <button className="btn-s" onClick={() => { void refreshLocal(); void refreshFleet(); }}>重试</button> : null}
                  {empty.action === 'settings' ? <button className="btn-s" onClick={() => setView('settings')}>去设置</button> : null}
                </>
              );
            })()}</div>
          ) : (
            <div className="sess">
              <div className="shead-wrap" ref={headRef}>
                <header className="shead glass">
                  <div className="shead-l">
                    <span className={`dot ${statusDotForSession({ status: sessionView.status, last_event: activeSummary?.last_event }) === 'idle' ? '' : statusDotForSession({ status: sessionView.status, last_event: activeSummary?.last_event })}`} />
                    <div className="shead-t">
                      {titleEditing && canRenameSession(active?.machine) ? (
                        <input
                          ref={titleEditRef}
                          className="title-edit"
                          value={titleDraft ?? title}
                          aria-label="改标题"
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onBlur={() => void renameTitle()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void renameTitle(); }
                            if (e.key === 'Escape') { e.preventDefault(); setTitleEditing(false); setTitleDraft(null); }
                          }}
                        />
                      ) : (
                        <h1
                          role="button"
                          tabIndex={0}
                          title={canRenameSession(active?.machine) ? `${title || '新会话'} · 点一下改名` : `${title || '新会话'} · 点一下复制`}
                          onClick={() => { if (canRenameSession(active?.machine)) beginRename(); else void copyTitle(); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (canRenameSession(active?.machine)) beginRename(); else void copyTitle(); } }}
                        >{title || '新会话'}</h1>
                      )}
                      <span className="shead-state">{STATUS_LABEL[sessionView.status] ?? sessionView.status}{stream === 'reconnecting' ? ' · 重连中' : ''}</span>
                      {canSetSessionRule(active?.machine) ? (
                        ruleEditing ? (
                          <textarea
                            ref={ruleEditRef}
                            className="title-edit"
                            rows={2}
                            value={ruleDraft ?? sessionView.rule ?? activeSummary?.rule ?? ''}
                            aria-label="这条会话的规矩"
                            placeholder="写一句规矩，空的就是去掉"
                            onChange={(e) => setRuleDraft(e.target.value)}
                            onBlur={() => void saveRule()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveRule(); }
                              if (e.key === 'Escape') { e.preventDefault(); setRuleEditing(false); setRuleDraft(null); }
                            }}
                          />
                        ) : (
                          <button className="link dim" type="button" onClick={beginRule}>
                            {(sessionView.rule || activeSummary?.rule) ? `规矩 · ${(sessionView.rule || activeSummary?.rule || '').split('\n')[0]}` : '加一句规矩'}
                          </button>
                        )
                      ) : null}
                    </div>
                  </div>
                  <div className="shead-r">
                    <button className="chip" onClick={(e) => { e.stopPropagation(); modelMenu(); }} disabled={!canDrive || activeSummary.harness !== 'pi'}><b>{prettyModelName(sessionView.model)}</b>{providerOf(sessionView.model) ? <span className="car">▼</span> : null}</button>
                    <button className="chip" onClick={(e) => { e.stopPropagation(); thinkMenu(); }} disabled={!canDrive}>思考 <b>{THINKING_LABEL[sessionView.thinking] ?? sessionView.thinking}</b><span className="car">▼</span></button>
                    <button className="chip" onClick={(e) => { e.stopPropagation(); policyMenu(); }} disabled={!canDrive}>审批 <b>{POLICY_LABEL[sessionView.policy] ?? sessionView.policy}</b><span className="car">▼</span></button>
                    {cwd ? (
                      <button className="chip win" title={cwd} onClick={(e) => { e.stopPropagation(); if (active?.machine === 'local') void revealCwd(); else void copyCwd(); }}>{cwdChipLabel(cwd)}</button>
                    ) : null}
                    {boundWindowChipKind(active?.machine ?? '', boundWindowText) === 'raise' ? (
                      <button className="chip win" type="button" title={`${boundWindowText} · 点一下提到前面`} onClick={(e) => { e.stopPropagation(); void api.raiseBoundWindow(active!).then(() => toast('已提到前面')).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true)); }}>{boundWindowText}</button>
                    ) : boundWindowChipKind(active?.machine ?? '', boundWindowText) === 'bind' ? (
                      <button className="chip win" type="button" title="列出本机窗口再绑一扇" onClick={(e) => { e.stopPropagation(); openWindowOp(); }}>绑窗口</button>
                    ) : boundWindowChipKind(active?.machine ?? '', boundWindowText) === 'label' ? (
                      <span className="chip win" title="窗口在对面那台机器上,这里提不起来">{boundWindowText}</span>
                    ) : null}
                    <button className="chip" onClick={(e) => { e.stopPropagation(); moreMenu(e.currentTarget); }}>⋯</button>
                  </div>
                </header>
                {netOffline ? (
                  <div className="need-strip glass">
                    <span className="cnt">{offlineBanner()}</span>
                  </div>
                ) : null}
                {othersNeedingYou.length > 0 && (() => {
                  const first = othersNeedingYou[0];
                  const pending = firstPendingApproval(first.s);
                  const cmd = pending?.command ?? first.s.last_event?.text ?? '';
                  const acts = approvalChoiceActions(pending?.choices ?? ['once', 'deny']);
                  return (
                    <div className="need-strip glass">
                      <span className="cnt">需要你 · {othersNeedingYou.length}</span>
                      <span className="it">{first.s.title || '会话'} —— 在 {machineChipLabel(first.machineName)} 上执行 <code>{cmd.split('\n')[0]}</code></span>
                      {pending ? acts.map((act) => (
                        <button key={act.choice} className="go" type="button" onClick={() => void approveTarget({ machine: first.machine, id: first.s.session_id }, pending.approvalId, act.choice)}>{act.label}</button>
                      )) : null}
                      <button className="go" type="button" onClick={() => openSession({ machine: first.machine, id: first.s.session_id })}>去看</button>
                    </div>
                  );
                })()}
                {flowFind.open ? (
                  <div className="flow-find">
                    <input
                      ref={flowFindRef}
                      value={flowFind.query}
                      onChange={(e) => setFlowFind((cur) => ({ ...cur, query: e.target.value, index: 0 }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault();
                      }}
                      placeholder="在这条会话里找"
                      aria-label="在这条会话里找"
                    />
                    <span className="flow-find-hits">{flowFind.query.trim() ? flowFindStatus(findHits.length, findIndex) : flowFindEmptyHint()}</span>
                    <div className="flow-find-acts">
                      <button className="link" type="button" title="上一条" aria-label="上一条" disabled={!findHits.length} onClick={() => stepFind(-1)}>{flowFindActLabel('prev')}</button>
                      <button className="link" type="button" title="下一条" aria-label="下一条" disabled={!findHits.length} onClick={() => stepFind(1)}>{flowFindActLabel('next')}</button>
                      <button className="link" type="button" title="复制当前命中" disabled={!findHits.length} onClick={() => void copyFindHit()}>{flowFindActLabel('copy')}</button>
                      <button className="link" type="button" title="关闭查找" onClick={() => setFlowFind({ open: false, query: '', index: 0 })}>{flowFindActLabel('close')}</button>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="flow" ref={flowRef} onScroll={(e) => { const el = e.currentTarget; setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40); }}>
                <div className="flow-in">
                  {needsSettings && !canDrive ? (
                    <div className="empty-main in-flow">
                      <b>{settingsNeededCopy().title}</b>
                      <span>{settingsNeededCopy().hint}</span>
                      <button className="btn-s" onClick={() => setView('settings')}>去设置</button>
                    </div>
                  ) : (
                    <>
                      {sessionView.rows.length === 0 && <div className="fc sys" style={{ padding: '8px 0' }}>{canDrive ? '等待事件…' : endedSessionHint(activeSummary.status)}</div>}
                      {sessionView.rows.map((row) => (
                        <div
                          key={row.key}
                          data-flow-key={row.key}
                          className={flowFind.query.trim() && !flowRowMatchesQuery(row, flowFind.query) ? 'frow-miss' : findKey === row.key || failFocusKey === row.key ? 'frow-hit' : undefined}
                        >
                          <Row row={row} model={sessionView.model} query={flowFind.query} hide={hideSecretsOn} onApprove={approve} onDiff={() => openTouchedFile(row.k === 'edit' ? row.file : '')} onOpen={readFileFromRow(row) ? () => openTouchedFile(readFileFromRow(row)) : undefined} />
                        </div>
                      ))}
                    </>
                  )}
                </div>
                {!stickBottom && unseen > 0 && (
                  <button className="jump-latest" onClick={() => { setStickBottom(true); const flow = flowRef.current; if (flow) flow.scrollTop = flow.scrollHeight; }}>最新 {unseen}<kbd>↓</kbd></button>
                )}
              </div>
              <div className={`composer-wrap${flowFind.open ? ' find-away' : ''}`} ref={composerRef} aria-hidden={flowFind.open || undefined}>
                {canDrive ? (
                  <div className="composer">
                    <textarea ref={taRef} rows={1} value={draft} placeholder={composerPlaceholder(cwdChipLabel(cwd), false)}
                      onChange={(e) => { setDraft(e.target.value); const ta = e.target; ta.style.height = 'auto'; ta.style.height = `${Math.min(180, ta.scrollHeight)}px`; layoutFlow(); }}
                      onPaste={onComposerPaste}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={onComposerDrop}
                      onKeyDown={(e) => { if (composerShouldSend(e) && draft.trim() && !needsModelSwitch) { e.preventDefault(); if (canQueueOnEnter({ machine: active?.machine, status: sessionView.status, prompt: draft })) void followUp(); else void send(); } }} />
                    {needsModelSwitch ? (
                      <div className="newbox-warn">
                        <b>这个模型当前账号用不了。</b>
                        换一个再继续。会话还在，不用新开。
                        <button className="btn-s" onClick={modelMenu}>换模型</button>
                      </div>
                    ) : null}
                    <div className="composer-bar">
                      <span className="cb info">{stream === 'reconnecting' ? '事件流在重连,发出去的话会等接通。' : needsModelSwitch ? `先换一个模型,再以这条会话继续 · 现在是 ${prettyModelName(sessionView.model)}` : composerShowsSteer(sessionView.status) ? composerRunningHint(prettyModelName(sessionView.model), canFollowUp) : `将在 ${machineChipLabel(activeGroup?.name) || '这台机器'} 上以 ${prettyModelName(sessionView.model)} 继续 · 审批:${POLICY_LABEL[sessionView.policy] ?? sessionView.policy}`}</span>
                      <span className="composer-acts">
                        {composerShowsSteer(sessionView.status)
                          ? <><button className="btn-s" onClick={() => void send()} disabled={busy || !draft.trim() || needsModelSwitch}>插话</button>{canFollowUp ? <button className="btn-s" onClick={() => void followUp()} disabled={busy || !draft.trim() || needsModelSwitch}>接着</button> : null}{canMentionLast ? <button className="btn-s dim" type="button" onClick={mentionLast}>带上上一句</button> : null}{canFollowUp && queuedFollowUps.length ? <button className="btn-s dim" onClick={clearFollowUps} disabled={busy}>取消排队</button> : null}<button className="btn-s stop" onClick={() => void stop()} disabled={busy}>停止</button></>
                          : <><button className="btn-s" onClick={() => void send()} disabled={busy || !draft.trim() || needsModelSwitch}>发送</button>{canRetryLast ? <button className="btn-s dim" type="button" onClick={() => void retryLast()} disabled={busy || needsModelSwitch}>再发上一句</button> : null}{canMentionLast ? <button className="btn-s dim" type="button" onClick={mentionLast}>带上上一句</button> : null}</>}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="composer ended">
                    <textarea ref={taRef} rows={1} value={draft} placeholder={composerPlaceholder(cwdChipLabel(cwd), true)}
                      onChange={(e) => { setDraft(e.target.value); const ta = e.target; ta.style.height = 'auto'; ta.style.height = `${Math.min(180, ta.scrollHeight)}px`; layoutFlow(); }}
                      onPaste={onComposerPaste}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={onComposerDrop}
                      onKeyDown={(e) => { if (composerShouldSend(e) && draft.trim() && !needsSettings) { e.preventDefault(); if (canResumeThenSend({ machine: active?.machine, canResume: canResumeHere, prompt: draft })) void send(); else if (canResumeHere) resumeHere(); else continueHere(); } }} />
                    <div className="composer-end">
                      <span className="composer-end-hint"><b>{endedComposerLead(activeSummary.status)}</b>{cwd ? ` · ${cwdChipLabel(cwd)}` : ''}</span>
                      <div className="composer-end-acts">
                        {canMentionLast ? <button className="link" type="button" onClick={mentionLast}>带上上一句</button> : null}
                        {canCopyLast ? <button className="link" type="button" onClick={() => { void copyLastReply(); }}>复制刚说的</button> : null}
                        {canSpeakLast ? <button className="link" type="button" onClick={speakLast}>读出刚说的</button> : null}
                        {canEditLast ? <button className="link" type="button" onClick={editLastPrompt}>改上一句</button> : null}
                        {canMentionTool ? <button className="link" type="button" onClick={mentionTool}>带上刚打出来的</button> : null}
                        {canOpenWritten ? <button className="link" type="button" onClick={openLastWritten}>打开刚写的</button> : null}
                        {canJumpFail ? <button className="link" type="button" onClick={jumpLastFail}>看刚失败的</button> : null}
                        {canOpenRead ? <button className="link" type="button" onClick={openLastRead}>打开刚读的</button> : null}
                        {needsSettings ? <button className="btn-s" onClick={() => setView('settings')}>去设置</button> : canResumeThenSend({ machine: active?.machine, canResume: canResumeHere, prompt: draft }) ? <button className="btn-s" type="button" onClick={() => { void send(); }}>{resumeThenSendLabel()}</button> : canResumeHere ? <button className="btn-s" onClick={resumeHere}>接着这条会话</button> : <button className="btn-s" onClick={continueHere}>在同一目录新开</button>}
                        {needsSettings ? <button className="link" onClick={continueHere}>仍要新开</button> : canResumeHere ? <button className="link" onClick={continueHere}>在同一目录新开</button> : null}
                        {cwd && active?.machine === 'local' ? <button className="link" onClick={() => void revealCwd()}>在 Finder 打开</button> : null}
                        {canOpenSessionPath(active?.machine, cwd) ? <button className="link" onClick={() => void openCwdTerm()}>在终端打开</button> : null}
                        {cwd ? <button className="link" onClick={() => void copyCwd()}>复制路径</button> : null}
                        {sessionCanForget(activeSummary.status) && active ? <button className="link dim" onClick={() => void forgetSession(active)}>从左栏拿掉</button> : null}
                        {canForgetEnded ? <button className="link dim" onClick={() => void forgetEnded()}>清掉已经结束的</button> : null}
                        {canHere ? <button className="link" type="button" onClick={() => openHere()}>这个目录的会话</button> : null}
                        {canPulse ? <button className="link" type="button" onClick={showPulse}>这条聊了多少</button> : null}
                        {canFork ? <button className="link" type="button" onClick={() => void forkHere()}>从这里分一条</button> : null}
                        {canImportHere ? <button className="link" type="button" onClick={() => { void importTalk(); }}>接回记下的对话</button> : null}
                        {canLinks ? <button className="link" type="button" onClick={() => openTalkLink()}>打开对话里的链接</button> : null}
                        {canCopyTalkHere ? <button className="link" type="button" onClick={() => { void copyTalk(); }}>复制这次对话</button> : null}
                        {canPrintTalkHere ? <button className="link" type="button" onClick={() => { void printTalk(); }}>打印这次对话</button> : null}
                        {canHideHere ? <button className="link" type="button" onClick={toggleHideSecrets}>{hideSecretsOn ? '显示密钥' : '藏住密钥'}</button> : null}
                        {canOpenAtLoginHere ? <button className="link" type="button" onClick={() => { void toggleOpenAtLogin(); }}>{openAtLoginLabel(openAtLogin)}</button> : null}
                        {canHotkeyHere ? <button className="link" type="button" onClick={() => { void toggleGlobalHotkey(); }}>{globalHotkeyLabel(globalHotkey)}</button> : null}
                        {canAlwaysOnTopHere ? <button className="link" type="button" onClick={() => { void toggleAlwaysOnTop(); }}>{alwaysOnTopLabel(alwaysOnTop)}</button> : null}
                        {canAllSpacesHere ? <button className="link" type="button" onClick={() => { void toggleAllSpaces(); }}>{allSpacesLabel(allSpaces)}</button> : null}
                        {canProtectHere ? <button className="link" type="button" onClick={() => { void toggleContentProtection(); }}>{contentProtectionLabel(contentProtection)}</button> : null}
                        {canDoneChimeHere ? <button className="link" type="button" onClick={toggleDoneChime}>{doneChimeLabel(doneChimeOn)}</button> : null}
                        {canOpenLogsHere ? <button className="link" type="button" onClick={() => { void openLogsHere(); }}>{openLogsLabel()}</button> : null}
                        {canOpenA11yHere ? <button className="link" type="button" onClick={() => { void openA11yHere(); }}>{openAccessibilityLabel()}</button> : null}
                        {canRelaunchHere ? <button className="link" type="button" onClick={() => { void relaunchHere(); }}>{relaunchLabel()}</button> : null}
                        {canExtraHere ? <button className="link" type="button" onClick={() => { void extraHere(); }}>{extraWindowLabel()}</button> : null}
                        {canEmojiHere ? <button className="link" type="button" onClick={() => { void emojiHere(); }}>{emojiLabel()}</button> : null}
                        {canClearCacheHere ? <button className="link" type="button" onClick={() => { void clearCacheHere(); }}>{clearCacheLabel()}</button> : null}
                        {canLockHere ? <button className="link" type="button" onClick={() => { void lockHere(); }}>{lockLabel(appLocked)}</button> : null}
                        {canCliHere ? <button className="link" type="button" onClick={() => { void cliHere(); }}>{installCliLabel(cliInstalled)}</button> : null}
                        {canAppsHere ? <button className="link" type="button" onClick={() => { void appsHere(); }}>{moveToApplicationsLabel(inApplications)}</button> : null}
                        {canCheckUpdateHere ? <button className="link" type="button" onClick={() => { void checkUpdateHere(); }}>{checkUpdateLabel(updateState)}</button> : null}
                        <button className="link" type="button" onClick={followSystemHere}>{followSystemLabel(themeMode)}</button>
                        {canDictateHere ? <button className="link" type="button" onClick={dictateHere}>{dictating ? '停住' : '对着说'}</button> : null}
                        {canRecallHere ? <button className="link" onClick={() => void openRecall()}>找回来</button> : null}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          {view === 'devices' && <DevicesPage local={local} fleet={fleet} stale={fleetHealth.stale} toast={toast} focusMachine={focusMachine} onNewOn={(m) => { setFocusMachine(null); if (m === 'local') beginLocalNew(); else { setNewBox({ open: true, machine: m }); setView('home'); } }} onOpenRelay={() => { setOpenLegacy(true); setView('settings'); }} />}
          {view === 'channels' && <ChannelsPage toast={toast} models={configuredModels} />}
          {view === 'settings' && <SettingsPage toast={toast} onProvidersChanged={() => void refreshProviders()} openLegacy={openLegacy} onLegacyClosed={() => setOpenLegacy(false)} onShowWhatsNew={() => setWhatsNew(currentReleaseNote() ?? LEO_RELEASE_NOTES[0] ?? null)} onCheckUpdate={canCheckUpdateHere ? () => { void checkUpdateHere(); } : undefined} checkUpdateLabel={checkUpdateLabel(updateState)} onClearCache={canClearCacheHere ? () => { void clearCacheHere(); } : undefined} onLockApp={canLockHere ? () => { void lockHere(); } : undefined} lockLabel={lockLabel(appLocked)} onInstallCli={canCliHere ? () => { void cliHere(); } : undefined} installCliLabel={installCliLabel(cliInstalled)} />}
        </main>
      </div>

      <aside className={`drawer ${drawer ? 'open' : ''}`} role={drawer ? 'dialog' : undefined} aria-modal={drawer ? true : undefined} aria-hidden={!drawer} aria-label={drawer ? `${drawerTitle}${activeGroup ? ` · ${machineChipLabel(activeGroup.name)}` : ''}` : undefined}>
        <header><span>{drawerTitle}{activeGroup ? ` · ${machineChipLabel(activeGroup.name)}` : ''}</span><button ref={drawerCloseRef} className="link" onClick={() => setDrawer(null)}>关闭<kbd>Esc</kbd></button></header>
        <div className={`drawer-body ${drawer === 'diff' ? 'pad' : ''}`}>
          {remoteCopy ? (
            <div className="remote-hint">
              <b>{remoteCopy.lead}</b>
              <p>{remoteCopy.body}</p>
              {drawer === 'files' && artifactError ? <p>{artifactError}</p> : null}
              {drawer === 'files' && filePins.length > 0 ? (
                <>
                  <ul className="remote-files">
                    {filePins.map((row) => (
                      <li key={row.key}>
                        <button className={`link ${focusFile === row.file ? 'on' : ''}`} onClick={() => setFocusFile(row.file)}><code>{row.file}</code></button>
                        <span>{row.state}</span>
                      </li>
                    ))}
                  </ul>
                  {filePeekBlock}
                </>
              ) : null}
              <div className="remote-acts">
                {remoteDrawerActions({ cwd }).map((action) => {
                  const label = REMOTE_DRAWER_ACTION_LABEL[action];
                  const run = action === 'copy-cwd' ? () => void copyCwd() : action === 'continue' ? continueHere : action === 'new-on-machine' ? newOnMachine : showDevice;
                  return action === 'copy-cwd' || action === 'continue'
                    ? <button key={action} className="btn-s" onClick={run}>{label}</button>
                    : <button key={action} className="btn" onClick={run}>{label}</button>;
                })}
              </div>
            </div>
          ) : drawer === 'diff' ? (
            filePins.length === 0 && filePeek == null && commits.length === 0 && !logError ? (
              <div className="remote-hint"><b>这条会话还没有改动文件。</b><p>改过之后会出现在这里，点文件名看这次改了哪几行。</p></div>
            ) : (
              <div className="local-files">
                {artifactError ? <p className="remote-hint">{artifactError}</p> : null}
                {filePins.length > 0 ? (
                  <ul className="remote-files">
                    {filePins.map((row) => (
                      <li key={row.key}>
                        <button className={`link ${focusFile === row.file && !focusCommit ? 'on' : ''}`} onClick={() => { setFocusCommit(null); setFocusFile(row.file); }}><code>{row.file}</code></button>
                        <span>{row.state}</span>
                        {canRevertSessionFile(active?.machine, row.file) ? <button className="link" type="button" onClick={() => { void revertFile(row.file); }}>还原</button> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {logError && !commits.length ? <p className="remote-hint">{logError}</p> : null}
                {commits.length > 0 ? (
                  <ul className="remote-files">
                    {commits.map((row) => (
                      <li key={row.hash}>
                        <button className={`link ${focusCommit === row.hash ? 'on' : ''}`} type="button" onClick={() => { setFocusFile(null); setFocusCommit(row.hash); }}><code>{row.hash}</code></button>
                        <span>{row.subject}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {filePeekBlock}
                {canCommitHere ? (
                  <div className="local-files-commit">
                    <input
                      value={commitDraft ?? defaultCommitMessage(title)}
                      onChange={(e) => setCommitDraft(e.target.value)}
                      placeholder="这次改了什么"
                      aria-label="这次改了什么"
                    />
                    <button className="btn-s" type="button" onClick={() => { void commitFiles(); }}>记下这次改动</button>
                  </div>
                ) : null}
                {canBranchHere ? (
                  <form className="local-files-commit" onSubmit={(e) => { e.preventDefault(); void switchBranch(); }}>
                    <input
                      value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      placeholder="分支名，空的就是 leo-分支"
                      aria-label="分支名"
                    />
                    <button className="btn-s" type="submit">开这条分支</button>
                    {canMergeHere ? <button className="btn-s" type="button" onClick={() => { void mergeBranch(); }}>并到现在这条</button> : null}
                  </form>
                ) : null}
                {canInitHere ? <div className="local-files-commit"><button className="btn-s" type="button" onClick={() => { void initRepo(); }}>做成仓库</button></div> : null}
                {canPushHere ? <div className="local-files-commit"><button className="btn-s" type="button" onClick={() => { void pushRepo(); }}>推到远端</button></div> : null}
                {canPullHere ? <div className="local-files-commit"><button className="btn-s" type="button" onClick={() => { void pullRepo(); }}>拉回远端</button></div> : null}
                {canApplyHere ? <div className="local-files-commit"><button className="btn-s" type="button" onClick={() => { void applyPatch(); }}>贴上补丁</button></div> : null}
                {canPackHere ? <div className="local-files-commit"><button className="btn-s" type="button" onClick={() => { void packChanges(); }}>带走这次改动</button></div> : null}
                {canUnpackHere ? <div className="local-files-commit"><button className="btn-s" type="button" onClick={() => { void unpackZip(); }}>解开这份 zip</button></div> : null}
              </div>
            )
          ) : drawer === 'files' && active?.machine === 'local' ? (
            workspaceError ? (
              <div className="remote-hint"><b>打不开这个目录。</b><p>{workspaceError}</p></div>
            ) : workspace?.projectId ? (
              <div className="local-files">
                <form className="local-files-search" onSubmit={(e) => { e.preventDefault(); void searchHere(); }}>
                  <input
                    ref={wsSearchRef}
                    value={wsQuery}
                    onChange={(e) => setWsQuery(e.target.value)}
                    placeholder="在这个目录里搜正文"
                    aria-label="在这个目录里搜正文"
                  />
                  <button className="btn-s" type="submit" disabled={!searchQueryReady(wsQuery)}>搜</button>
                </form>
                {canSeedHere ? (
                  <form className="local-files-search" onSubmit={(e) => { e.preventDefault(); void seedFile(); }}>
                    <input
                      value={seedName}
                      onChange={(e) => setSeedName(e.target.value)}
                      placeholder="新文件名，比如 notes/idea.md"
                      aria-label="新文件名"
                    />
                    <button className="btn-s" type="submit">建这个文件</button>
                  </form>
                ) : null}
                {canMkdirHere ? (
                  <form className="local-files-search" onSubmit={(e) => { e.preventDefault(); void mkdirFolder(); }}>
                    <input
                      value={folderName}
                      onChange={(e) => setFolderName(e.target.value)}
                      placeholder="新文件夹名，比如 notes/草稿"
                      aria-label="新文件夹名"
                    />
                    <button className="btn-s" type="submit">建这个文件夹</button>
                  </form>
                ) : null}
                {canBranchHere ? (
                  <form className="local-files-search" onSubmit={(e) => { e.preventDefault(); void switchBranch(); }}>
                    <input
                      value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      placeholder="分支名，空的就是 leo-分支"
                      aria-label="分支名"
                    />
                    <button className="btn-s" type="submit">开这条分支</button>
                    {canMergeHere ? <button className="btn-s" type="button" onClick={() => { void mergeBranch(); }}>并到现在这条</button> : null}
                  </form>
                ) : null}
                {canInitHere ? <div className="local-files-search"><button className="btn-s" type="button" onClick={() => { void initRepo(); }}>做成仓库</button></div> : null}
                {canMoveHere ? (
                  <form className="local-files-search" onSubmit={(e) => { e.preventDefault(); void moveFile(); }}>
                    <input
                      value={moveDest}
                      onChange={(e) => setMoveDest(e.target.value)}
                      placeholder="挪进哪个文件夹，空的就是目录根上"
                      aria-label="挪进哪个文件夹"
                    />
                    <button className="btn-s" type="submit">挪进这个文件夹</button>
                  </form>
                ) : null}
                {canCwdRuleHere ? (
                  cwdRuleEditing ? (
                    <form className="local-files-search" onSubmit={(e) => { e.preventDefault(); void saveCwdRule(); }}>
                      <textarea
                        ref={cwdRuleEditRef}
                        className="title-edit"
                        rows={2}
                        value={cwdRuleDraft ?? sessionView.cwdRule ?? activeSummary?.cwd_rule ?? ''}
                        aria-label="这个目录的规矩"
                        placeholder="写一句规矩，空的就是去掉"
                        onChange={(e) => setCwdRuleDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveCwdRule(); }
                          if (e.key === 'Escape') { e.preventDefault(); setCwdRuleEditing(false); setCwdRuleDraft(null); }
                        }}
                      />
                      <button className="btn-s" type="submit">记下</button>
                    </form>
                  ) : (
                    <div className="local-files-commit">
                      <button className="link" type="button" onClick={beginCwdRule}>
                        {(sessionView.cwdRule || activeSummary?.cwd_rule) ? `目录规矩 · ${(sessionView.cwdRule || activeSummary?.cwd_rule || '').split('\n')[0]}` : '这个目录的规矩'}
                      </button>
                    </div>
                  )
                ) : null}
                {canUnpackHere ? <div className="local-files-commit"><button className="btn-s" type="button" onClick={() => { void unpackZip(); }}>解开这份 zip</button></div> : null}
                {wsHits.length > 0 || wsTruncated ? (
                  <ul className="remote-files">
                    {wsHits.map((hit) => (
                      <li key={`${hit.file}:${hit.line}:${hit.text}`}>
                        <button className={`link ${focusFile === hit.file ? 'on' : ''}`} type="button" onClick={() => setFocusFile(hit.file)}><code>{hit.file}:{hit.line}</code></button>
                        <span>{hit.text}</span>
                      </li>
                    ))}
                    {wsTruncated ? <li><span>还有没列完的命中</span></li> : null}
                  </ul>
                ) : null}
                {filePins.length > 0 ? (
                  <ul className="remote-files">
                    {filePins.map((row) => (
                      <li key={row.key}>
                        <button className={`link ${focusFile === row.file ? 'on' : ''}`} onClick={() => setFocusFile(row.file)}><code>{row.file}</code></button>
                        <span>{row.state}</span>
                        {canRevertSessionFile(active?.machine, row.file) ? <button className="link" type="button" onClick={() => { void revertFile(row.file); }}>还原</button> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {filePeekBlock}
                <div className="drawer-host local-files-tree"><Suspense fallback={<div style={{ padding: 16, color: 'var(--fg3)' }}>加载中…</div>}>
                  <FileTree selectedProject={workspace} onFileOpen={(filePath) => setFocusFile(filePath)} />
                </Suspense></div>
              </div>
            ) : (
              <div style={{ padding: 16, color: 'var(--fg3)' }}>正在打开目录…</div>
            )
          ) : drawer === 'term' && active?.machine === 'local' ? (
            workspaceError ? (
              <div className="remote-hint"><b>打不开这个目录。</b><p>{workspaceError}</p></div>
            ) : workspace?.projectId ? (
              <div className="drawer-host"><Suspense fallback={<div style={{ padding: 16, color: 'var(--fg3)' }}>加载中…</div>}>
                <Shell selectedProject={workspace} isPlainShell autoConnect isActive minimal />
              </Suspense></div>
            ) : (
              <div style={{ padding: 16, color: 'var(--fg3)' }}>正在打开目录…</div>
            )
          ) : drawer === 'browser' && project ? (
            <div className="drawer-host"><Suspense fallback={<div style={{ padding: 16, color: 'var(--fg3)' }}>加载中…</div>}>
              <BrowserUsePanel isVisible />
            </Suspense></div>
          ) : null}
        </div>
      </aside>

      {palette.open && (
        <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onClick={(e) => { if (e.target === e.currentTarget) setPalette({ open: false, query: '', index: 0 }); }}>
          <div className="pbox">
            <input autoFocus placeholder="命令、会话或设备…  ↑↓ 选择  ↩ 执行" value={palette.query}
              onChange={(e) => setPalette((p) => ({ ...p, query: e.target.value, index: 0 }))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setPalette((p) => ({ ...p, index: Math.min(filteredCommands.length - 1, p.index + 1) })); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setPalette((p) => ({ ...p, index: Math.max(0, p.index - 1) })); }
                else if (e.key === 'Enter') { e.preventDefault(); runCommand(palette.index); }
                else if (e.key === 'Escape') { setPalette({ open: false, query: '', index: 0 }); }
              }} />
            <div className="plist">
              {filteredCommands.length === 0 && <div className="pempty">没有匹配的命令</div>}
              {filteredCommands.map((c, i) => (
                <div key={`${c.g}-${c.t}-${i}`}>
                  {(i === 0 || filteredCommands[i - 1].g !== c.g) && <div className="psec">{c.g}</div>}
                  <button className={`pli ${i === palette.index ? 'on' : ''}`} onMouseEnter={() => setPalette((p) => ({ ...p, index: i }))} onClick={() => runCommand(i)}><span>{c.t}</span><span className="k">{c.k}</span></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {picker && (
        <div className="palette" role="dialog" aria-modal="true" aria-label={picker.kind === 'model' ? '选择模型' : picker.kind === 'policy' ? '审批策略' : picker.kind === 'recall' ? '找回来' : picker.kind === 'here' ? '这个目录的会话' : picker.kind === 'link' ? '对话里的链接' : '思考深度'} onClick={(e) => { if (e.target === e.currentTarget) setPicker(null); }}>
          <div className="pbox">
            <input autoFocus placeholder={picker.kind === 'model' ? '搜索模型或供应商…' : picker.kind === 'recall' ? '找拿掉的会话…' : picker.kind === 'here' ? '找同目录会话…' : picker.kind === 'link' ? '找链接…' : '筛选…'} value={picker.query}
              onChange={(e) => setPicker((p) => (p ? { ...p, query: e.target.value, index: 0 } : p))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setPicker((p) => (p ? { ...p, index: Math.min(pickerItems.length - 1, p.index + 1) } : p)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setPicker((p) => (p ? { ...p, index: Math.max(0, p.index - 1) } : p)); }
                else if (e.key === 'Enter') { e.preventDefault(); runPicker(picker.index); }
                else if (e.key === 'Escape') { setPicker(null); }
              }} />
            <div className="plist">
              {pickerItems.length === 0 && <div className="pempty">没有匹配的项</div>}
              {pickerItems.map((it, i) => (
                <div key={`${it.g}-${it.v}-${i}`}>
                  {(i === 0 || pickerItems[i - 1].g !== it.g) && <div className="psec">{it.g}</div>}
                  <button className={`pli ${i === picker.index ? 'on' : ''}`} onMouseEnter={() => setPicker((p) => (p ? { ...p, index: i } : p))} onClick={() => runPicker(i)}><span>{it.t}</span><span className="k">{it.sub}</span></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) => it.sep ? <div className="msep" key={`sep-${i}`} /> : (
            <button key={`${it.v}-${i}`} className={`mi ${it.dim ? 'dim' : ''}`} onClick={() => { menu.onPick(it.v); setMenu(null); }}>
              <span className={`dot ${it.dot ?? ''}`} style={{ visibility: it.dot === undefined ? 'hidden' : 'visible' }} /><span>{it.t}</span><span className="sub">{it.sub ?? ''}</span>
            </button>
          ))}
        </div>
      )}

      {toasts.map((t) => <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.text}</div>)}
      {windowOp && (
        <div className="wn" role="dialog" aria-modal="true" aria-label="操作这个窗口">
          <div className="wn-mask" aria-hidden="true" onClick={() => setWindowOp(null)} />
          <div className="wn-box">
            <h2>操作这个窗口</h2>
            <p className="wn-ver">{windowOp.label}</p>
            {windowOp.peek ? <img className="win-peek" src={windowOp.peek} alt={windowOp.label} /> : null}
            {windowOp.windows.length > 0 ? (
              <ul className="win-list">
                {windowOp.windows.map((item) => (
                  <li key={item.snapshotId}>
                    <button
                      type="button"
                      className="link"
                      disabled={!active}
                      onClick={() => {
                        if (!active) return;
                        void api.bindSessionWindow(active, item.snapshotId).then((result) => {
                          toast(`已绑 ${result.app}`);
                          setWindowOp((cur) => (cur ? { ...cur, label: windowBoundLabel({ app: result.app, title: result.title }) || cur.label, menus: [] } : cur));
                          void api.peekBoundWindow(active).then((row) => {
                            const peek = row.image?.data ? `data:${row.image.mimeType || 'image/jpeg'};base64,${row.image.data}` : null;
                            setWindowOp((cur) => (cur ? { ...cur, peek, label: windowBoundLabel({ app: row.app, title: row.title }) || cur.label } : cur));
                          }).catch(() => undefined);
                          void api.listBoundWindowMenus(active).then((row) => {
                            setWindowOp((cur) => (cur ? { ...cur, menus: usableWindowMenus(row.menus), label: windowBoundLabel({ app: row.app, title: row.title }) || cur.label } : cur));
                          }).catch(() => undefined);
                        }).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
                      }}
                    >
                      {windowBoundLabel({ app: item.app, title: item.title }) || item.app}{item.frontmost ? ' · 前台' : ''}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="wn-ver">正在列出本机窗口…</p>}
            {windowOp.menus.length > 0 ? (
              <ul className="win-list">
                {windowOp.menus.map((item) => (
                  <li key={item.path.join('/')}>
                    <button
                      type="button"
                      className="link"
                      disabled={!active}
                      onClick={() => {
                        if (!active) return;
                        void api.menuBoundWindow(active, item.path).then((result) => {
                          toast(`已选 ${windowMenuLabel(result.path)} · ${result.app}`);
                        }).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
                      }}
                    >
                      {windowMenuLabel(item.path)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              className="win-hit"
              onPointerDown={(e) => {
                const point = clickPointFromElement(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
                winHitRef.current = point;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerUp={(e) => {
                const start = winHitRef.current;
                winHitRef.current = null;
                const end = clickPointFromElement(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
                if (!start || !end || !active) return;
                const gesture = windowPadGesture(start, end);
                const work = gesture.kind === 'drag'
                  ? api.dragBoundWindow(active, { x: gesture.from.x, y: gesture.from.y, x2: gesture.to.x, y2: gesture.to.y }).then((result) => toast(`已拖 ${result.app}`))
                  : api.clickBoundWindow(active, gesture.point).then((result) => toast(`已点 ${result.app}`));
                void work.catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
              }}
              onWheel={(e) => {
                e.preventDefault();
                const point = clickPointFromElement(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
                const delta = scrollDeltaFromWheel(e.deltaX, e.deltaY);
                if (!point || !delta || !active) return;
                void api.scrollBoundWindow(active, { ...point, ...delta }).then((result) => toast(`已滚 ${result.app}`)).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
              }}
            >
              点、滚、拖这个窗口里同一处
            </button>
            <textarea
              className="win-type"
              rows={3}
              placeholder="写入焦点输入框，或窗口里第一个能写的框"
              value={windowOp.draft}
              onChange={(e) => setWindowOp((cur) => (cur ? { ...cur, draft: e.target.value } : cur))}
            />
            <div className="wn-acts">
              <button
                className="btn-s"
                type="button"
                disabled={!windowOp.draft.trim() || !active}
                onClick={() => {
                  if (!active || !windowOp.draft) return;
                  void api.typeBoundWindow(active, { text: windowOp.draft }).then((result) => toast(`已写入 ${result.app}`)).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
                }}
              >
                写入
              </button>
              <button className="link" type="button" disabled={!active} onClick={() => readBoundField()}>读回来</button>
              <button className="link" type="button" onClick={() => setWindowOp(null)}>关闭</button>
            </div>
            <div className="win-keys">
              {WINDOW_KEY_BUTTONS.map((item) => (
                <button
                  key={item.key}
                  className="btn-s"
                  type="button"
                  disabled={!active}
                  onClick={() => {
                    if (!active) return;
                    void api.keyBoundWindow(active, item.key).then((result) => toast(`已按 ${item.label} · ${result.app}`)).catch((error) => toast(humanizeError(error instanceof Error ? error.message : String(error)), true));
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {whatsNew && <WhatsNewOverlay note={whatsNew} onDismiss={() => { markWhatsNewSeen(); setWhatsNew(null); }} />}
      {appLocked && canLockHere ? (
        <div className="wn" role="dialog" aria-modal="true" aria-label="已锁住">
          <div className="wn-mask" aria-hidden="true" />
          <div className="wn-box">
            <h2>已锁住</h2>
            <div className="wn-entry">
              <p className="wn-ver">锁屏或走开后，要解锁才看得到对话。</p>
            </div>
            <div className="wn-acts">
              <button className="btn-s" type="button" onClick={() => { void lockHere(); }}>解锁</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
