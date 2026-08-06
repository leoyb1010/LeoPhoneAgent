/**
 * evidence.ts —— learn 证据打包编排(检索 → 文本提取 → redact → 截断)。
 *
 * 规则 9:查询词、过滤维度、top-K、上下文半径、截断预算全部代码钉死
 * (常量在 evidence.pure.ts),模型只拿到打包好的证据块。检索函数注入,
 * 单测不需要 SQLite。
 */

import type { SearchChatHistoryHit, SearchChatHistoryResult } from '@cindy/mcps';

import { SESSION_SOURCES, type SessionSource } from '../../shared/sessionSource';
import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure';
import { createLogger } from '../logger';
import {
  EVIDENCE_CONTEXT_RADIUS,
  EVIDENCE_HIT_LIMIT,
  formatEvidenceBlock,
  truncateEvidence,
  type EvidenceItem,
} from './evidence.pure';
import { redactSensitive } from './redaction';

const log = createLogger('learn-host:evidence');

/**
 * 注入的检索函数 —— searchChatHistoryHybrid 的窄化形态。
 * (完整 EngineArgs 未导出;这里按需声明会用到的字段,结构兼容即可。)
 */
export type EvidenceSearchFn = (args: {
  query: string;
  sessionIds: string[] | null;
  workdir: string | null;
  fromMs: number | null;
  toMs: number | null;
  agentKind: null;
  roles: Array<'user' | 'assistant'>;
  contextRadius: number;
  limit: number;
  offset: number;
  excludeCleared?: boolean;
  sessionStatuses?: readonly ('active' | 'archived')[] | null;
  sessionSources?: readonly SessionSource[] | null;
}) => Promise<SearchChatHistoryResult>;

/** 证据来源白名单:排除 learn 蒸馏会话自身 —— 否则后续 /learn 会把此前
 *  蒸馏会话里模型自产的 skill 内容当"用户使用证据"捞回来,形成反馈回路
 *  (Codex review)。 */
const EVIDENCE_SESSION_SOURCES: readonly SessionSource[] = SESSION_SOURCES.filter(
  (s) => s !== 'learn',
);

export interface EvidenceBundle {
  /** 渲染进 prompt 的证据块(空串 = 无证据)。 */
  block: string;
  /** 是否实际命中并注入了本地会话内容(⇒ provenance.personal)。 */
  usedSessionEvidence: boolean;
  /** 命中条数(截断前)。 */
  hitCount: number;
}

/**
 * 按 query 检索本地会话历史并打包证据。
 * 检索异常不冒泡 —— learn 在"无历史/检索失败"时应退化为纯来源蒸馏,
 * 不能因为证据管道挂掉而整轮失败。
 */
export async function collectEvidence(query: string, search: EvidenceSearchFn): Promise<EvidenceBundle> {
  const q = query.trim();
  if (!q) return { block: '', usedSessionEvidence: false, hitCount: 0 };

  let result: SearchChatHistoryResult;
  try {
    result = await search({
      query: q,
      sessionIds: null,
      workdir: null,
      fromMs: null,
      toMs: null,
      agentKind: null,
      roles: ['user', 'assistant'],
      contextRadius: EVIDENCE_CONTEXT_RADIUS,
      limit: EVIDENCE_HIT_LIMIT,
      offset: 0,
      excludeCleared: true,
      sessionStatuses: ['active', 'archived'],
      sessionSources: EVIDENCE_SESSION_SOURCES,
    });
  } catch (err) {
    log.warn('evidence search failed (continuing without evidence):', err);
    return { block: '', usedSessionEvidence: false, hitCount: 0 };
  }

  const items = result.hits.map((hit) => toEvidenceItem(hit)).filter((i): i is EvidenceItem => i !== null);
  const truncated = truncateEvidence(items);
  const block = formatEvidenceBlock(truncated);
  return {
    block,
    usedSessionEvidence: truncated.items.length > 0,
    hitCount: result.hits.length,
  };
}

/** 把一条命中(含上下文窗口)拼成纯文本证据条,逐条 redact。 */
function toEvidenceItem(hit: SearchChatHistoryHit): EvidenceItem | null {
  const lines: string[] = [];
  const contextMessages = hit.context.length > 0 ? hit.context : [];
  for (const msg of contextMessages) {
    const text = visibleMessageTextForConversationSearch(msg.role, msg.content);
    if (!text) continue;
    lines.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  if (lines.length === 0) return null;
  const { text } = redactSensitive(lines.join('\n'));
  return { sessionId: hit.sessionId, createdAt: hit.createdAt, text };
}
