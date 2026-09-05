import { useTranslation } from 'react-i18next';
import { memo, useCallback, useMemo } from 'react';
import { Virtualizer } from 'virtua';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';

import type { ChatMessage } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelsDefinition,
} from '../../../../types/app';
import ErrorBoundary from '../../../main-content/view/ErrorBoundary';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { groupConsecutiveTools, isToolGroupItem } from '../../utils/toolGrouping';

import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import ToolGroupContainer from './ToolGroupContainer';
import LoadAllMessagesOverlay from './LoadAllMessagesOverlay';

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** First history fetch failed or timed out; the pane offers a retry. */
  sessionLoadError?: boolean;
  /** The transcript file behind this session no longer exists on disk. */
  transcriptMissing?: boolean;
  onRetrySessionLoad?: () => void;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /**
   * 指挥条/主控台已经带着 Agent 和第一句话开了这个会话,首条消息还在路上。
   * 这段时间 `chatMessages` 仍是空的,但不能弹「选择您的 AI 助手」——
   * 用户刚刚才选过 Agent,再让他选一次就是这个 bug 的表象本身。
   */
  isStartingNewSession?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  grokModel: string;
  setGrokModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
}

function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  sessionLoadError = false,
  transcriptMissing = false,
  onRetrySessionLoad,
  isProcessing = false,
  isStartingNewSession = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  opencodeModel,
  setOpenCodeModel,
  grokModel,
  setGrokModel,
  providerModelCatalog,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const groupedVisibleMessages = useMemo(
    () => groupConsecutiveTools(visibleMessages, Boolean(showThinking)),
    [visibleMessages, showThinking],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // The normalizer preserves unchanged ChatMessage objects. Deriving keys from
  // logical content still protects pagination boundaries and duplicate intrinsic
  // ids, avoiding remounts when older pages are prepended —
  // remounting the whole list, which disconnects the scroll-restore anchor and
  // reflows heights, jumping the viewport to the bottom. Deriving keys purely
  // from this render's ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) yields the same key for the same message
  // order, so React preserves existing DOM nodes and component state on prepend.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isToolGroupItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );


  const getLastMessage = useCallback((item: (typeof groupedVisibleMessages)[number] | undefined) => {
    if (!item) return null;
    return isToolGroupItem(item) ? item.messages[item.messages.length - 1] ?? null : item;
  }, []);

  const renderMessageItem = useCallback((item: (typeof groupedVisibleMessages)[number], index: number): ReactNode => {
    const prevMessage = getLastMessage(groupedVisibleMessages[index - 1]);
    if (isToolGroupItem(item)) {
      const groupKey = `tool-group-${getMessageKey(item.messages[0])}`;
      return (
        <ErrorBoundary key={groupKey} variant="inline" resetKeys={[groupKey]}>
          <ToolGroupContainer
            group={item}
            prevMessage={prevMessage}
            createDiff={createDiff}
            getMessageKey={getMessageKey}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={onGrantToolPermission}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            provider={provider}
          />
        </ErrorBoundary>
      );
    }

    const messageKey = getMessageKey(item);
    return (
      <ErrorBoundary key={messageKey} variant="inline" resetKeys={[messageKey]}>
        <MessageComponent
          message={item}
          prevMessage={prevMessage}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={onGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          provider={provider}
        />
      </ErrorBoundary>
    );
  }, [
    createDiff,
    getLastMessage,
    getMessageKey,
    groupedVisibleMessages,
    onFileOpen,
    onGrantToolPermission,
    onShowSettings,
    provider,
    selectedProject,
    showRawParameters,
    showThinking,
  ]);

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      <div className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-muted-foreground dark:text-muted-foreground">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-border" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 && transcriptMissing ? (
        <div role="status" className="mx-auto mt-8 max-w-md text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            {t('session.loading.transcriptMissing', { defaultValue: '这段对话的记录已不在本机' })}
          </p>
          <p className="mt-2 leading-6">
            {t('session.loading.transcriptMissingHint', {
              defaultValue: 'Claude Code 会定期清理旧的转录文件。会话名还留在列表里，但正文已经找不回来，可以在列表里删除这一条。',
            })}
          </p>
        </div>
      ) : chatMessages.length === 0 && sessionLoadError ? (
        <div role="alert" className="mx-auto mt-8 max-w-md text-center text-sm">
          <p className="font-medium text-foreground">
            {t('session.loading.error', { defaultValue: '无法加载会话消息' })}
          </p>
          <p className="mt-2 leading-6 text-muted-foreground">
            {t('session.loading.errorHint', {
              defaultValue: '本地服务没有在限定时间内返回这段对话。可以重试；如果一直失败，重启 leocodebox 后再试。',
            })}
          </p>
          <button
            type="button"
            onClick={onRetrySessionLoad}
            className="mt-4 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            {t('session.loading.retry', { defaultValue: '重试' })}
          </button>
        </div>
      ) : chatMessages.length === 0 && isStartingNewSession ? (
        <div className="mt-8 text-center text-sm text-muted-foreground">
          {t('session.loading.startingRun', { defaultValue: '正在开始…' })}
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          grokModel={grokModel}
          setGrokModel={setGrokModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-muted-foreground dark:text-muted-foreground">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-border" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            <div className="border-b border-border py-2 text-center text-sm text-muted-foreground dark:border-border dark:text-muted-foreground">
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </div>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          {/* Legacy message count indicator (for non-paginated view) */}
          {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
            <div className="border-b border-border py-2 text-center text-sm text-muted-foreground dark:border-border dark:text-muted-foreground">
              {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} |
              <button className="ml-1 text-info underline hover:text-info" onClick={loadEarlierMessages}>
                {t('session.messages.loadEarlier')}
              </button>
              {' | '}
              <button
                className="text-info underline hover:text-info dark:text-info dark:hover:text-info"
                onClick={loadAllMessages}
              >
                {t('session.messages.loadAll')}
              </button>
            </div>
          )}

          {groupedVisibleMessages.length >= 80 ? (
            <Virtualizer
              scrollRef={scrollContainerRef as RefObject<HTMLElement | null>}
              overscan={8}
              shift={isLoadingMoreMessages}
              item={({ children }) => <div className="pb-3 sm:pb-4">{children}</div>}
            >
              {groupedVisibleMessages.map((item, index) => renderMessageItem(item, index))}
            </Virtualizer>
          ) : (
            groupedVisibleMessages.map((item, index) => renderMessageItem(item, index))
          )}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
