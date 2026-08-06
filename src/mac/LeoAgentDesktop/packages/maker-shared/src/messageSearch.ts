import type {
  MessageRenderItem,
  MessageRenderNormalizedMessage,
  MessageRenderToolGroupItem,
  MessageRenderWorkChildItem,
} from './messageRender';

export interface MessageSearchAttachmentLike {
  name?: string;
  path?: string;
  uri?: string;
  mimeType?: string;
}

export interface MessageSearchMediaLike {
  kind?: string;
  title?: string;
  url?: string;
}

export interface MessageSearchDiffLike {
  filePath?: string;
  segments?: Array<{
    label?: string;
    oldString?: string;
    newString?: string;
  }>;
}

export type MessageSearchMessageLike = MessageRenderNormalizedMessage & {
  attachments?: readonly MessageSearchAttachmentLike[];
  diff?: MessageSearchDiffLike;
  media?: readonly MessageSearchMediaLike[];
  systemCardData?: Record<string, unknown>;
};

export interface MessageSearchHit {
  itemKey: string;
  sourceKey: string;
  label: string;
  preview: string;
}

export function findMessageSearchHits<TMessage extends MessageSearchMessageLike>(
  items: readonly MessageRenderItem<TMessage>[],
  query: string,
): MessageSearchHit[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const hits: MessageSearchHit[] = [];
  for (const item of items) {
    const hit = searchItem(item, item.key, normalizedQuery);
    if (hit) hits.push(hit);
  }
  return hits;
}

/**
 * 在一段纯文本上做与 render-item 搜索一致的匹配(同样的归一化 + 预览窗口),命中返回 hit、否则 null。
 * 供 host 端的额外可搜索文本(如手机端子 agent 卡的 summary / 派活描述)复用,避免各自重写归一化 / 预览逻辑。
 */
export function findTextSearchHit(
  params: { itemKey: string; sourceKey: string; label: string; text: string },
  query: string,
): MessageSearchHit | null {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return null;
  return searchTextBlock({ ...params, normalizedQuery });
}

export function normalizeMessageSearchIndex(
  hitCount: number,
  currentIndex: number,
): number {
  if (hitCount <= 0) return -1;
  if (!Number.isFinite(currentIndex) || currentIndex < 0) return 0;
  if (currentIndex >= hitCount) return hitCount - 1;
  return currentIndex;
}

export function nextMessageSearchIndex(
  hitCount: number,
  currentIndex: number,
  direction: 'previous' | 'next',
): number {
  if (hitCount <= 0) return -1;
  if (!Number.isFinite(currentIndex) || currentIndex < 0) {
    return direction === 'previous' ? hitCount - 1 : 0;
  }
  const normalized = normalizeMessageSearchIndex(hitCount, currentIndex);
  if (direction === 'previous') return (normalized - 1 + hitCount) % hitCount;
  return (normalized + 1) % hitCount;
}

function searchItem<TMessage extends MessageSearchMessageLike>(
  item: MessageRenderItem<TMessage> | MessageRenderWorkChildItem<TMessage>,
  itemKey: string,
  normalizedQuery: string,
): MessageSearchHit | null {
  if (item.type === 'message') {
    return searchMessage(item.message, itemKey, normalizedQuery);
  }
  if (item.type === 'thinking') {
    return searchTextBlock({
      itemKey,
      sourceKey: item.key,
      label: 'thinking',
      text: `思考 ${item.message.body}`,
      normalizedQuery,
    });
  }
  if (item.type === 'tool_group') {
    return searchToolGroup(item, itemKey, normalizedQuery);
  }
  if (item.type === 'todo') {
    return searchTextBlock({
      itemKey,
      sourceKey: item.key,
      label: 'todo',
      text: item.todos.map((todo) => `${todo.status} ${todo.content} ${todo.activeForm ?? ''}`).join('\n'),
      normalizedQuery,
    });
  }
  if (item.type === 'agent_task') {
    const update = item.update;
    // 重连后(无 live update)卡片标题/详情来自工具输入、结果摘要来自 secondaryBody;一并纳入搜索,
    // 与卡片可见内容对齐(否则用户看到的子任务标题 / prompt / 结果搜不到)。
    const content = item.toolCall?.source.content;
    const input = content && typeof content === 'object' && !Array.isArray(content)
      ? (content as Record<string, unknown>).input
      : undefined;
    const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : undefined;
    const inputText = inputRecord
      ? (['description', 'prompt', 'task', 'name'] as const)
          .map((key) => inputRecord[key])
          .filter((value): value is string => typeof value === 'string')
      : [];
    const text = [
      update?.title,
      update?.description,
      update?.summary,
      update?.lastToolName,
      update?.outputFile,
      item.toolCall?.label,
      item.toolCall?.body,
      item.toolCall?.secondaryBody,
      ...inputText,
    ].filter(Boolean).join('\n');
    return searchTextBlock({
      itemKey,
      sourceKey: item.key,
      label: 'agent_task',
      text,
      normalizedQuery,
    });
  }
  // tool_media 是所属 tool_group 内媒体的**再呈现**(同一批 tool 消息引用),
  // 其文本已随 tool_group → searchMessage 的 mediaText 纳入索引;这里再搜会产生
  // 同内容双命中,直接跳过。
  if (item.type === 'tool_media') return null;
  for (const child of item.children) {
    const hit = searchItem(child, item.key, normalizedQuery);
    if (hit) return hit;
  }
  return null;
}

function searchToolGroup<TMessage extends MessageSearchMessageLike>(
  item: MessageRenderToolGroupItem<TMessage>,
  itemKey: string,
  normalizedQuery: string,
): MessageSearchHit | null {
  for (const tool of item.tools) {
    const hit = searchMessage(tool, itemKey, normalizedQuery);
    if (hit) return hit;
  }
  return null;
}

function searchMessage<TMessage extends MessageSearchMessageLike>(
  message: TMessage,
  itemKey: string,
  normalizedQuery: string,
): MessageSearchHit | null {
  const attachmentText = message.attachments
    ?.map((attachment) => [
      attachment.name,
      attachment.path,
      attachment.uri,
      attachment.mimeType,
    ].filter(Boolean).join(' '))
    .join('\n') ?? '';
  const mediaText = message.media
    ?.map((media) => [media.kind, media.title, media.url].filter(Boolean).join(' '))
    .join('\n') ?? '';
  const diffText = message.diff
    ? [
      message.diff.filePath,
      ...(message.diff.segments ?? []).flatMap((segment) => [
        segment.label,
        segment.oldString,
        segment.newString,
      ]),
    ].filter(Boolean).join('\n')
    : '';
  const systemCardText = message.systemCardData
    ? JSON.stringify(message.systemCardData)
    : '';

  return searchTextBlock({
    itemKey,
    sourceKey: message.key,
    label: message.label || message.kind,
    text: [
      message.label,
      message.body,
      message.secondaryBody,
      attachmentText,
      mediaText,
      diffText,
      systemCardText,
    ].filter(Boolean).join('\n'),
    normalizedQuery,
  });
}

function searchTextBlock({
  itemKey,
  sourceKey,
  label,
  normalizedQuery,
  text,
}: {
  itemKey: string;
  sourceKey: string;
  label: string;
  normalizedQuery: string;
  text: string;
}): MessageSearchHit | null {
  const normalizedText = normalizeSearchText(text);
  const matchIndex = normalizedText.indexOf(normalizedQuery);
  if (matchIndex < 0) return null;
  return {
    itemKey,
    sourceKey,
    label,
    preview: buildSearchPreview(text, normalizedQuery),
  };
}

function buildSearchPreview(text: string, normalizedQuery: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const index = normalizeSearchText(compact).indexOf(normalizedQuery);
  if (index < 0) return compact.slice(0, 88);
  const start = Math.max(0, index - 32);
  const end = Math.min(compact.length, index + normalizedQuery.length + 48);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}

function normalizeSearchText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
