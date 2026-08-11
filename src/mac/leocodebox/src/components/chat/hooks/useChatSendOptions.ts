import { useCallback } from 'react';

import type { LLMProvider, ProjectSession } from '../../../types/app';
import { safeLocalStorage, type QueuedSendOptions } from '../utils/chatStorage';
import type { PermissionMode } from '../types/types';

interface UseChatSendOptionsArgs {
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  resolvePermissionModeForProvider: (
    provider: LLMProvider,
    requestedMode: PermissionMode | string,
  ) => PermissionMode;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  opencodeModel: string;
  grokModel: string;
  currentProviderEffort: string;
  selectedSession: ProjectSession | null;
}

export function getNotificationSessionSummary(
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) return null;
  return normalizedFallback.length > 80
    ? `${normalizedFallback.slice(0, 77)}...`
    : normalizedFallback;
}

function readToolsSettings(provider: LLMProvider) {
  try {
    const settingsKey = provider === 'cursor'
      ? 'cursor-tools-settings'
      : provider === 'codex'
        ? 'codex-settings'
        : provider === 'opencode'
          ? 'opencode-settings'
          : provider === 'grok'
            ? 'grok-settings'
            : 'claude-settings';
    const savedSettings = safeLocalStorage.getItem(settingsKey);
    if (savedSettings) return JSON.parse(savedSettings);
  } catch (error) {
    console.error('Error loading tools settings:', error);
  }

  return {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false,
  };
}

export function useChatSendOptions({
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
}: UseChatSendOptionsArgs) {
  return useCallback((currentInput: string): QueuedSendOptions => {
    const toolsSettings = readToolsSettings(provider);
    const model = provider === 'cursor'
      ? cursorModel
      : provider === 'codex'
        ? codexModel
        : provider === 'opencode'
          ? opencodeModel
          : provider === 'grok'
            ? grokModel
            : claudeModel;

    return {
      model,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    claudeModel,
    codexModel,
    currentProviderEffort,
    cursorModel,
    opencodeModel,
    grokModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);
}
