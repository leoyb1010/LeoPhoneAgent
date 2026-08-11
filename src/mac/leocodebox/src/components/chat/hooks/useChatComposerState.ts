import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  MutableRefObject,
  SetStateAction,
  TouchEvent,
} from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import { persistHandoffSource } from '../../../hooks/projectStateUtils';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import {
  safeLocalStorage,
} from '../utils/chatStorage';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';

import { useFileMentions } from './useFileMentions';
import { useChatImageAttachments } from './useChatImageAttachments';
import { useChatTextareaLayout } from './useChatTextareaLayout';
import { getNotificationSessionSummary, useChatSendOptions } from './useChatSendOptions';
import type { SlashCommand } from './useSlashCommands';
import { useChatCommands } from './useChatCommands';
export type {
  CommandModalKind,
  CommandModalPayload,
  CostCommandData,
  HelpCommandData,
  ModelCommandData,
  StatusCommandData,
} from './useChatCommands';
import { useQueuedChatDraft } from './useQueuedChatDraft';
export type { QueuedDraft } from './useQueuedChatDraft';

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  /** Bumped by the parent each time a brand-new session is started. */
  newSessionTrigger?: number;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  currentProviderEffort: string;
  opencodeModel: string;
  grokModel: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

interface MentionableFile {
  name: string;
  path: string;
}



const createFakeSubmitEvent = () => ({
  preventDefault: () => undefined,
}) as unknown as FormEvent<HTMLFormElement>;


export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  newSessionTrigger,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  cursorModel,
  claudeModel,
  codexModel,
  currentProviderEffort,
  opencodeModel,
  grokModel,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const {
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    handlePaste,
    resetImageAttachments,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
  } = useChatImageAttachments();
  const {
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    isInputFocused,
    resizeTextarea,
    collapseTextarea,
    syncInputOverlayScroll,
    handleInputFocusChange,
  } = useChatTextareaLayout({ input, onInputFocusChange });

  const handleSubmitRef = useRef<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  // Holds the source session id from a ⌘K handoff until the new session's id is
  // assigned (on first send), so the return ticket can be persisted then.
  const pendingHandoffSourceRef = useRef<string | null>(null);
  // One-shot grace flag: the handoff itself bumps newSessionTrigger, so the
  // first trigger change after arming must keep the ref; any later change means
  // the handoff was abandoned for another new session, so the ref is dropped.
  const handoffArmedRef = useRef(false);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  const { queuedDraft, queueDraft, editQueuedDraft, deleteQueuedDraft } = useQueuedChatDraft({
    sessionKey,
    isLoading,
    setInput,
    inputValueRef,
    setAttachedImages,
    textareaRef,
    handleSubmitRef: handleSubmitRef as MutableRefObject<((event: FormEvent<HTMLFormElement>) => Promise<void>) | null>,
  });
  const {
    commandModalPayload,
    closeCommandModal,
    executeCommand,
    showCostModal,
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useChatCommands({
    selectedProject,
    currentSessionId,
    provider,
    cursorModel,
    claudeModel,
    codexModel,
    opencodeModel,
    grokModel,
    tokenBudget,
    input,
    setInput,
    inputValueRef,
    textareaRef,
    handleSubmitRef: handleSubmitRef as MutableRefObject<((event: FormEvent<HTMLFormElement>) => Promise<void>) | null>,
    addMessage,
    onFileOpen,
    onShowSettings,
  });






  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const buildSendOptions = useChatSendOptions({
    provider,
    permissionMode,
    resolvePermissionModeForProvider,
    cursorModel,
    claudeModel,
    codexModel,
    opencodeModel,
    grokModel,
    currentProviderEffort,
    selectedSession,
  });

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      if (!currentInput.trim() || !selectedProject) {
        return;
      }

      // A turn is already in flight: stash this message instead of sending it.
      // It's auto-flushed (re-running this same function) once the turn ends,
      // so it still goes through slash-command interception, image upload, etc.
      if (isLoading) {
        queueDraft({
          content: currentInput,
          images: attachedImages,
          options: buildSendOptions(currentInput),
        });
        setInput('');
        inputValueRef.current = '';
        resetImageAttachments();
        resetCommandMenuState();
        collapseTextarea();
        // selectedProject is guaranteed by the guard at the top of handleSubmit.
        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          setInput('');
          inputValueRef.current = '';
          resetImageAttachments();
          resetCommandMenuState();
          collapseTextarea();
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedImages: unknown[] = [];
      if (attachedImages.length > 0) {
        const formData = new FormData();
        attachedImages.forEach((file) => {
          formData.append('images', file);
        });

        try {
          const response = await apiClient.raw('/api/assets/images', {
            method: 'POST',
            headers: {},
            body: formData,
          });
          const result = await response.json() as { images?: unknown[] };
          uploadedImages = result.images || [];
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Image upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload images: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        try {
          const body = await apiClient.post<{ data?: { sessionId?: string } }>(
            '/api/providers/sessions',
            { provider, projectPath: resolvedProjectPath },
          );
          targetSessionId = body?.data?.sessionId || null;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: sessionSummary,
        });

        // Only the handoff-created new session records a return ticket; continuing
        // an existing session never writes one.
        if (pendingHandoffSourceRef.current) {
          persistHandoffSource(targetSessionId, pendingHandoffSourceRef.current);
          pendingHandoffSourceRef.current = null;
        }
      }

      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: uploadedImages as any,
        timestamp: new Date(),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content: messageContent,
        options: {
          ...buildSendOptions(messageContent),
          images: uploadedImages,
        },
      });

      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      resetImageAttachments();
      collapseTextarea();

      safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
    },
    [
      selectedSession,
      attachedImages,
      buildSendOptions,
      collapseTextarea,
      currentSessionId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      queueDraft,
      resetCommandMenuState,
      resetImageAttachments,
      scrollToBottom,
      selectedProject,
      sendMessage,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  // ⌘K "Handoff to…" pre-fills the composer with an editable handoff preamble
  // after switching provider; nothing is sent until the user confirms.
  useEffect(() => {
    const onHandoffDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; sourceSessionId?: string }>).detail;
      if (detail?.sourceSessionId) {
        pendingHandoffSourceRef.current = detail.sourceSessionId;
        handoffArmedRef.current = true;
      }
      const text = detail?.text;
      if (typeof text === 'string' && text) {
        inputValueRef.current = text;
        setInput(text);
      }
    };
    window.addEventListener('leocodebox:handoff-draft', onHandoffDraft);
    return () => window.removeEventListener('leocodebox:handoff-draft', onHandoffDraft);
  }, []);

  // Bound the pending handoff source to exactly the session the handoff created.
  // The handoff's own onStartNewChat bumps newSessionTrigger first, so consume a
  // one-shot grace on that change; any subsequent new session drops the ref.
  useEffect(() => {
    if (handoffArmedRef.current) {
      handoffArmedRef.current = false;
      return;
    }
    pendingHandoffSourceRef.current = null;
  }, [newSessionTrigger]);

  // Navigating to an existing session also abandons a pending handoff.
  useEffect(() => {
    if (selectedSession?.id) {
      pendingHandoffSourceRef.current = null;
      handoffArmedRef.current = false;
    }
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);


  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        collapseTextarea();
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [collapseTextarea, handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    collapseTextarea(true);
  }, [collapseTextarea, resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );



  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
