import { useCallback, useState } from 'react';
import type { Dispatch, FormEvent, MutableRefObject, RefObject, SetStateAction } from 'react';

import type { ChatMessage } from '../types/types';
import type { LLMProvider, Project, ProviderModelsCacheInfo } from '../../../types/app';
import { apiClient } from '../../../utils/apiClient';
import { escapeRegExp } from '../utils/chatFormatting';

import { type SlashCommand, useSlashCommands } from './useSlashCommands';

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
}

export type ModelCommandData = {
  current?: { provider?: string; providerLabel?: string; model?: string };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: Array<{ value: string; label?: string; description?: string }>;
  defaultModel?: string;
  cache?: ProviderModelsCacheInfo;
};
export type CostCommandData = {
  tokenUsage?: { used?: number; total?: number };
  tokenBreakdown?: { input?: number; output?: number };
  provider?: string;
  model?: string;
};
export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: { rssMb?: number; heapUsedMb?: number; heapTotalMb?: number };
};
export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{ name: string; description?: string; namespace?: string }>;
};
export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';
export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

type UseChatCommandsArgs = {
  selectedProject: Project | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  opencodeModel: string;
  grokModel: string;
  tokenBudget: Record<string, unknown> | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  inputValueRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  handleSubmitRef: MutableRefObject<((event: FormEvent<HTMLFormElement>) => Promise<void>) | null>;
  addMessage: (message: ChatMessage) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
};

const fakeSubmitEvent = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;

export function useChatCommands({
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
  handleSubmitRef,
  addMessage,
  onFileOpen,
  onShowSettings,
}: UseChatCommandsArgs) {
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const handleBuiltInCommand = useCallback((result: CommandExecutionResult) => {
    const { action, data } = result;
    if (action === 'help' || action === 'models' || action === 'cost' || action === 'status') {
      setCommandModalPayload({ kind: action, data: data || {} } as CommandModalPayload);
      return;
    }
    if (action === 'memory') {
      addMessage({
        type: 'assistant',
        content: data.error ? `Warning: ${data.message}` : `${data.message}\n\nPath: \`${data.path}\``,
        timestamp: Date.now(),
      });
      if (!data.error && data.exists && onFileOpen) onFileOpen(data.path);
      return;
    }
    if (action === 'config') {
      onShowSettings?.();
      return;
    }
    console.warn('Unknown built-in command action:', action);
  }, [addMessage, onFileOpen, onShowSettings]);

  const closeCommandModal = useCallback(() => setCommandModalPayload(null), []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    if (result.hasBashCommands && !window.confirm(
      'This command contains bash commands that will be executed. Do you want to proceed?',
    )) {
      addMessage({ type: 'assistant', content: 'Command execution cancelled', timestamp: Date.now() });
      return;
    }
    const commandContent = result.content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;
    setTimeout(() => handleSubmitRef.current?.(fakeSubmitEvent), 0);
  }, [addMessage, handleSubmitRef, inputValueRef, setInput]);

  const executeCommand = useCallback(async (
    command: SlashCommand,
    rawInput?: string,
    options?: { preserveInput?: boolean },
  ) => {
    if (!command || !selectedProject) return;
    try {
      const effectiveInput = rawInput ?? input;
      const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
      const args = commandMatch?.[1] ? commandMatch[1].trim().split(/\s+/) : [];
      const context = {
        projectPath: selectedProject.fullPath || selectedProject.path,
        projectId: selectedProject.projectId,
        sessionId: currentSessionId,
        provider,
        model: provider === 'cursor' ? cursorModel
          : provider === 'codex' ? codexModel
            : provider === 'opencode' ? opencodeModel
              : provider === 'grok' ? grokModel : claudeModel,
        tokenUsage: tokenBudget,
      };
      const result = await apiClient.post<CommandExecutionResult>('/api/commands/execute', {
        commandName: command.name,
        commandPath: command.path,
        args,
        context,
      });
      if (result.type === 'builtin') {
        handleBuiltInCommand(result);
        if (!options?.preserveInput) {
          setInput('');
          inputValueRef.current = '';
        }
      } else if (result.type === 'custom') {
        await handleCustomCommand(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error executing command:', error);
      addMessage({ type: 'assistant', content: `Error executing command: ${message}`, timestamp: Date.now() });
    }
  }, [
    addMessage,
    claudeModel,
    codexModel,
    currentSessionId,
    cursorModel,
    handleBuiltInCommand,
    handleCustomCommand,
    input,
    inputValueRef,
    opencodeModel,
    grokModel,
    provider,
    selectedProject,
    setInput,
    tokenBudget,
  ]);

  const showCostModal = useCallback(() => {
    void executeCommand({
      name: '/cost',
      description: 'Display token usage information',
      namespace: 'builtin',
      metadata: { type: 'builtin' },
    } as SlashCommand, '/cost', { preserveInput: true });
  }, [executeCommand]);

  const slashCommandState = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  return {
    commandModalPayload,
    closeCommandModal,
    executeCommand,
    showCostModal,
    ...slashCommandState,
  };
}
