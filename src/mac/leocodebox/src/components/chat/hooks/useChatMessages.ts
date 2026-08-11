/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
};

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
  };
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[] while
 * preserving object identity for unchanged source rows. React.memo can then
 * skip old markdown/tool messages while only the active stream bubble updates.
 */
type CachedConversion = {
  toolResultSource: NormalizedMessage | null;
  output: ChatMessage[];
};

export type ChatMessageNormalizer = (messages: NormalizedMessage[]) => ChatMessage[];

export function createChatMessageNormalizer(): ChatMessageNormalizer {
  const cache = new WeakMap<NormalizedMessage, CachedConversion>();

  return (messages: NormalizedMessage[]): ChatMessage[] => {
    const converted: ChatMessage[] = [];
    const toolResultMap = new Map<string, NormalizedMessage>();
    const toolUseIds = new Set<string>();

    for (const msg of messages) {
      if (msg.kind === 'tool_use' && msg.toolId) toolUseIds.add(msg.toolId);
      if (msg.kind === 'tool_result' && msg.toolId) toolResultMap.set(msg.toolId, msg);
    }

    for (const msg of messages) {
      const toolResultSource = msg.kind === 'tool_use'
        ? (msg.toolResult ? msg : (msg.toolId ? toolResultMap.get(msg.toolId) ?? null : null))
        : null;
      const cached = cache.get(msg);
      if (cached && cached.toolResultSource === toolResultSource) {
        converted.push(...cached.output);
        continue;
      }

      const output = convertNormalizedMessage(msg, toolResultMap, toolUseIds);
      cache.set(msg, { toolResultSource, output });
      converted.push(...output);
    }

    return converted;
  };
}

function convertNormalizedMessage(
  msg: NormalizedMessage,
  toolResultMap: Map<string, NormalizedMessage>,
  toolUseIds: Set<string>,
): ChatMessage[] {
  const output: ChatMessage[] = [];
  const sharedMetadata = {
    displayText: msg.displayText,
    commandName: msg.commandName,
    commandMessage: msg.commandMessage,
    commandArgs: msg.commandArgs,
    isLocalCommand: msg.isLocalCommand,
    isLocalCommandStdout: msg.isLocalCommandStdout,
    isCompactSummary: msg.isCompactSummary,
  };

  switch (msg.kind) {
    case 'text': {
      const content = msg.content || '';
      const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
      if (!content.trim() && !images) break;

      if (msg.role === 'user') {
        const taskNotif = parseTaskNotification(content);
        if (taskNotif) {
          output.push({
            type: 'assistant',
            content: taskNotif.summary,
            timestamp: msg.timestamp,
            isTaskNotification: true,
            taskStatus: taskNotif.status,
            ...sharedMetadata,
          });
          if (taskNotif.result) {
            output.push({
              type: 'assistant',
              content: formatUsageLimitText(unescapeWithMathProtection(decodeHtmlEntities(taskNotif.result))),
              timestamp: msg.timestamp,
              ...sharedMetadata,
            });
          }
        } else {
          output.push({
            type: 'user',
            content: unescapeWithMathProtection(decodeHtmlEntities(content)),
            timestamp: msg.timestamp,
            images,
            ...sharedMetadata,
          });
        }
      } else {
        let text = decodeHtmlEntities(content);
        text = unescapeWithMathProtection(text);
        text = formatUsageLimitText(text);
        output.push({ type: 'assistant', content: text, timestamp: msg.timestamp, ...sharedMetadata });
      }
      break;
    }

    case 'tool_use': {
      const tr = msg.toolResult || (msg.toolId ? toolResultMap.get(msg.toolId) : null);
      const isSubagentContainer = msg.toolName === 'Task';
      const childTools: SubagentChildTool[] = [];
      if (isSubagentContainer && Array.isArray(msg.subagentTools)) {
        for (const tool of msg.subagentTools as any[]) {
          childTools.push({
            toolId: tool.toolId,
            toolName: tool.toolName,
            toolInput: tool.toolInput,
            toolResult: tool.toolResult || null,
            timestamp: new Date(tool.timestamp || Date.now()),
          });
        }
      }
      const toolResult = tr
        ? {
            content: formatToolResultContent(tr.content),
            isError: Boolean(tr.isError),
            toolUseResult: (tr as any).toolUseResult,
          }
        : null;

      output.push({
        type: 'assistant',
        content: '',
        timestamp: msg.timestamp,
        isToolUse: true,
        toolName: msg.toolName,
        toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
        toolId: msg.toolId,
        toolResult,
        isSubagentContainer,
        subagentState: isSubagentContainer
          ? { childTools, currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1, isComplete: Boolean(toolResult) }
          : undefined,
        ...sharedMetadata,
      });
      break;
    }

    case 'thinking':
      if (msg.content?.trim()) {
        output.push({ type: 'assistant', content: unescapeWithMathProtection(msg.content), timestamp: msg.timestamp, isThinking: true, ...sharedMetadata });
      }
      break;
    case 'error':
      output.push({ type: 'error', content: msg.content || 'Unknown error', errorCode: msg.errorCode, rawError: msg.rawError, timestamp: msg.timestamp, ...sharedMetadata });
      break;
    case 'interactive_prompt':
      output.push({ type: 'assistant', content: msg.content || '', timestamp: msg.timestamp, isInteractivePrompt: true, ...sharedMetadata });
      break;
    case 'task_notification':
      output.push({ type: 'assistant', content: msg.summary || 'Background task update', timestamp: msg.timestamp, isTaskNotification: true, taskStatus: msg.status || 'completed', ...sharedMetadata });
      break;
    case 'stream_delta':
      if (msg.content) output.push({ type: 'assistant', content: msg.content, timestamp: msg.timestamp, isStreaming: true, ...sharedMetadata });
      break;
    case 'tool_result': {
      if (msg.toolId && toolUseIds.has(msg.toolId)) break;
      if (msg.toolId) break;
      const content = formatToolResultContent(msg.content || '');
      if (content.trim()) output.push({ type: msg.isError ? 'error' : 'assistant', content, timestamp: msg.timestamp, toolId: msg.toolId, ...sharedMetadata });
      break;
    }
    default:
      break;
  }

  return output;
}

/** One-shot converter retained for tests and non-React callers. */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  return createChatMessageNormalizer()(messages);
}
