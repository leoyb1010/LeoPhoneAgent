/**
 * tool-error-telemetry.ts
 * ---------------------------------------------------------------------------
 * lizi_* MCP server 的 errorCode 遥测出口。
 *
 * 背景:各 server 的 registry / call_tool 把 UNKNOWN_TOOL / INVALID_ARGS 以及
 * 业务 handler 的 errorCode payload 直接返回给模型自纠,全程零日志——
 * "agent 在哪个工具上犯什么错、犯了几次"在日志里完全不存在。本模块在
 * call_tool 出口统一拦一道,凡结果带 errorCode(或 isError)就往 host 注入的
 * LiziMcpLogger 打一条结构化 warn,只落现有日志管道,不做上报。
 *
 * 约束:
 *  - 绝不能影响工具返回——任何解析失败都静默吞掉,原样放行结果。
 *  - 成功路径零解析开销——只有 `isError: true` 的结果才会被 JSON.parse。依据是
 *    lizi_* server 的既有约定:错误结果一律带 isError(xdt-helper 统一走
 *    `_payload.ts` 的 errorPayload,registry 的 UNKNOWN_TOOL / INVALID_ARGS 与
 *    computer server 的 textResult(x, true) 亦然)。成功结果可能很大(如
 *    get_chat_history 单页上千条消息),不能为遥测多付一次 O(size) 反序列化。
 */

import type { LiziMcpLogger } from './types.js';

/** 各 registry / server 返回的工具结果最小结构(content + 可选 isError)。 */
interface ToolResultLike {
  content?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * 从工具结果的第一个 text content block 里解析出 errorCode 字符串。
 * 约定:lizi_* server 的错误 payload 形如 `{ok: false, errorCode, data}`,
 * 序列化成 JSON 放在 content[0].text。解析不出(非 JSON / 无 errorCode)返回 null。
 */
export function extractToolResultErrorCode(result: ToolResultLike): string | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const firstText = content.find(
    (item): item is { type: 'text'; text: string } =>
      !!item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string',
  );
  if (!firstText) return null;
  try {
    const parsed: unknown = JSON.parse(firstText.text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const errorCode = (parsed as { errorCode?: unknown }).errorCode;
      if (typeof errorCode === 'string' && errorCode) return errorCode;
    }
  } catch {
    // 非 JSON text(如纯文本结果)不是错误约定的一部分,忽略。
  }
  return null;
}

/**
 * call_tool 出口遥测:`isError: true` 的结果解析出 errorCode 后打一条结构化 warn。
 * 成功结果(无 isError)直接跳过,不做任何解析。不 throw、不改结果;
 * logger 缺失时为 no-op。
 */
export function logToolResultErrorCode(params: {
  logger: LiziMcpLogger | undefined;
  /** MCP server 名,如 'cindy_helper' / 'cindy_computer'。 */
  server: string;
  /** call_tool 里被调用的具体工具名。 */
  tool: string;
  result: ToolResultLike;
  sessionId?: string;
}): void {
  const { logger, server, tool, result, sessionId } = params;
  if (!logger) return;
  if (result.isError !== true) return;
  try {
    logger.warn('tool call returned errorCode', {
      server,
      tool,
      errorCode: extractToolResultErrorCode(result),
      ...(sessionId ? { sessionId } : {}),
    });
  } catch {
    // 遥测绝不能影响工具返回。
  }
}
