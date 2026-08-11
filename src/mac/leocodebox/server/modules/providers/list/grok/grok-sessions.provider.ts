import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'grok';

/**
 * grok stores per-session transcripts under ~/.grok/sessions/<encoded-cwd>/<id>/,
 * where <cwd> is the REALPATH of the working dir (grok resolves symlinks before
 * encoding — verified on macOS where /var → /private/var). Encode the realpath
 * too, or history lookups miss sessions whose project path has a symlinked
 * component. Fall back to the raw path when it can't be resolved (e.g. removed).
 */
export function grokSessionDir(projectPath: string, sessionId: string): string {
  const raw = projectPath || process.cwd();
  let resolved = raw;
  try {
    resolved = realpathSync(raw);
  } catch {
    // Path gone or unreadable — keep the raw form; the lookup simply won't match.
  }
  return path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(resolved), sessionId);
}

function isInternalUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<user_info>') || t.startsWith('<system_reminder>');
}

function joinTextParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof (part as AnyRecord)?.text === 'string' ? (part as AnyRecord).text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class GrokSessionsProvider implements IProviderSessions {
  /**
   * Normalizes LIVE grok streaming-json events. grok's headless stream only
   * surfaces `thought` (reasoning) and `text` (assistant) deltas — tool calls
   * are executed but not emitted as structured stream events, so they don't
   * appear here (they DO appear in fetchHistory from the on-disk transcript).
   * The terminal `end` event is consumed by the runtime, not this adapter.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) return [];
    if (raw.type === 'thought' && typeof raw.data === 'string' && raw.data) {
      return [createNormalizedMessage({ kind: 'thinking', content: raw.data, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'text' && typeof raw.data === 'string' && raw.data) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.data, sessionId, provider: PROVIDER })];
    }
    return [];
  }

  /**
   * Reads grok's on-disk chat_history.jsonl — a clean OpenAI-shaped transcript
   * with reasoning / assistant(+tool_calls) / tool_result / user turns — and
   * converts it to normalized messages with tool results attached to their calls.
   */
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { projectPath = '', limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;
    try {
      const historyPath = path.join(grokSessionDir(projectPath, providerSessionId), 'chat_history.jsonl');
      const raw = await fs.readFile(historyPath, 'utf8');
      const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const all = this.normalizeTranscript(rows, sessionId);
      const renderable = all.filter((msg) => msg.kind !== 'tool_result');
      const total = renderable.length;
      const { page, hasMore } = sliceTailPage(renderable, limit, offset);
      return { messages: page, total, hasMore, offset, limit };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GrokProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }

  /**
   * Public so tests can drive transcript normalization with synthetic rows.
   */
  normalizeTranscript(rows: string[], sessionId: string | null): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    const toolUseMap = new Map<string, NormalizedMessage>();
    const baseTime = Date.now();
    let seq = 0;

    for (const line of rows) {
      let entry: AnyRecord;
      try {
        entry = JSON.parse(line) as AnyRecord;
      } catch {
        continue;
      }
      const ts = new Date(baseTime + seq * 100).toISOString();
      const baseId = generateMessageId('grok');
      seq += 1;

      switch (entry.type) {
        case 'user': {
          if (entry.synthetic_reason) break; // injected context, not a real turn
          const text = joinTextParts(entry.content);
          if (text.trim() && !isInternalUserText(text)) {
            messages.push(createNormalizedMessage({
              id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'text', role: 'user', content: text, sequence: seq,
            }));
          }
          break;
        }
        case 'reasoning': {
          const summary = joinTextParts(entry.summary);
          if (summary.trim()) {
            messages.push(createNormalizedMessage({
              id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'thinking', content: summary, sequence: seq,
            }));
          }
          break;
        }
        case 'assistant': {
          const text = joinTextParts(entry.content);
          if (text.trim()) {
            messages.push(createNormalizedMessage({
              id: baseId, sessionId, timestamp: ts, provider: PROVIDER, kind: 'text', role: 'assistant', content: text, sequence: seq,
            }));
          }
          const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
          for (let i = 0; i < toolCalls.length; i++) {
            const call = readObjectRecord(toolCalls[i]);
            if (!call) continue;
            const toolId = typeof call.id === 'string' ? call.id : `${baseId}_tc${i}`;
            const message = createNormalizedMessage({
              id: `${baseId}_${i}`, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_use',
              toolName: typeof call.name === 'string' ? call.name : 'tool', toolInput: parseToolArguments(call.arguments), toolId, sequence: seq,
            });
            messages.push(message);
            toolUseMap.set(toolId, message);
          }
          break;
        }
        case 'tool_result': {
          const toolId = typeof entry.tool_call_id === 'string' ? entry.tool_call_id : '';
          messages.push(createNormalizedMessage({
            id: `${baseId}_tr`, sessionId, timestamp: ts, provider: PROVIDER, kind: 'tool_result',
            toolId, content: typeof entry.content === 'string' ? entry.content : joinTextParts(entry.content), sequence: seq,
          }));
          break;
        }
        default:
          break; // system + unknown types are not rendered
      }
    }

    // Attach each tool_result to its tool_use so the UI can render them together.
    for (const msg of messages) {
      if (msg.kind === 'tool_result' && msg.toolId && toolUseMap.has(msg.toolId)) {
        const toolUse = toolUseMap.get(msg.toolId);
        if (toolUse) toolUse.toolResult = { content: msg.content, isError: msg.isError };
      }
    }
    return messages;
  }
}
