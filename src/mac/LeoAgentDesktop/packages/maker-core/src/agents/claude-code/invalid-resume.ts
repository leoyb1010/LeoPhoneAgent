/**
 * Claude Code resume 失败的稳定分类器。
 *
 * 这里只接受 CLI 明确的「conversation 不存在」文案，并在文案带 session id 时
 * 校验它确实等于本次尝试恢复的 id。普通 HTTP 404、网络错误或任意 SDK crash
 * 都不能触发上下文清除。
 */
export function isClaudeResumeSessionNotFound(value: unknown, expectedSessionId: string): boolean {
  if (!expectedSessionId) return false;
  for (const text of collectErrorTexts(value)) {
    const match = /No conversation found with session ID(?:\s*:\s*([^\s]+))?/i.exec(text);
    if (!match) continue;
    const reportedSessionId = match[1]?.replace(/[.,;!?]+$/, '');
    if (!reportedSessionId || reportedSessionId === expectedSessionId) return true;
  }
  return false;
}

/** 只读取 SDK 已知的浅层错误载荷，避免在事件热路径递归遍历任意大对象。 */
function collectErrorTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value instanceof Error) return [value.message];
  if (!isRecord(value)) return [];

  const type = value.type;
  if (
    typeof type === 'string' &&
    !((type === 'result' && value.is_error === true) || (type === 'assistant' && typeof value.error === 'string'))
  ) {
    return [];
  }

  const texts: string[] = [];
  for (const field of ['result', 'error'] as const) {
    if (typeof value[field] === 'string') texts.push(value[field]);
  }
  const message = value.message;
  if (typeof message === 'string') {
    texts.push(message);
  } else if (isRecord(message) && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRecord(block) && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
