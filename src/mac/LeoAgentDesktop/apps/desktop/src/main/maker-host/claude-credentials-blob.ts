/**
 * claude-credentials-blob —— Claude Code 共享凭证 blob 的**纯逻辑** helper。
 *
 * 故意不 import electron / logger / fs —— 这样可脱离 Electron 直接单测(规则 14),
 * 也把「写策略决策 / 登出裁剪计划 / 写后校验」这几处确定性逻辑从 IO 里拆出来(规则 9)。
 * 真正的 keychain / 文件 IO 在 claude-credentials-store.ts。
 */

/**
 * macOS `security -i`(stdin 交互解释器)的输入行缓冲上限约 4096 字节。超过后它会
 * **静默截断**那一行、用截断后的 hex 解码出半截 JSON 写进 keychain,并以 exit 1 收场 ——
 * 即「写失败 + 留下损坏值」。实测:整条命令行(add-generic-password 前缀 + hex + 引号)
 * ≈4041B 仍 OK、≈4141B 即截断。阈值按整行长度判定,留足余量到 3900。
 */
export const KEYCHAIN_INTERACTIVE_LINE_LIMIT = 3900;

/**
 * 决定 keychain 写入走哪条路:
 *   - 'stdin': 经 `security -i` 喂命令(hex 不出现在 argv/ps,隐私更好),仅适用于不超限的小 blob。
 *   - 'argv' : 直接 `security add-generic-password ... -X <hex>`,hex 走 argv(ARG_MAX≈1MB,
 *              远超 keychain 实际体量,不会被截断)。代价是 hex 短暂出现在同用户可见的 argv。
 *
 * @param interactiveCommandLength 走 stdin 时那一整行命令(含前缀与 hex)的字符长度。
 */
export function decideKeychainWriteMode(interactiveCommandLength: number): 'stdin' | 'argv' {
  return interactiveCommandLength <= KEYCHAIN_INTERACTIVE_LINE_LIMIT ? 'stdin' : 'argv';
}

/** 登出(清除 claudeAiOauth)的落地计划。 */
export type ClaudeOAuthClearPlan =
  /** 凭证库本就没有任何 blob —— 什么都不做。 */
  | { action: 'noop' }
  /** 删掉 claudeAiOauth 后整个 blob 空了 —— 可以删掉整条 keychain 条目 / 文件。 */
  | { action: 'delete' }
  /** blob 里还有其它字段(cc 的 mcpOAuth 等)—— 必须写回裁剪后的整块,不能删条目。 */
  | { action: 'write'; next: Record<string, unknown> };

/**
 * 计算「清除 claudeAiOauth」该如何落地。
 *
 * 关键不变量:Claude Code 把它**所有**凭证(claudeAiOauth 订阅登录 + 每个 MCP server 的
 * mcpOAuth token + 其它)塞在同一个 keychain 值里。删掉 claudeAiOauth 后若仍有其它字段,
 * 必须写回裁剪后的整块、而**不能**删掉整条条目 —— 否则会连带抹掉用户本机 `claude` CLI 的
 * MCP 登录等数据。返回 'write' 时 next 已剔除 claudeAiOauth、保留其余字段(浅拷贝,不改入参)。
 */
export function planClaudeAiOAuthClear(
  blob: Record<string, unknown> | null,
): ClaudeOAuthClearPlan {
  if (!blob) return { action: 'noop' };
  const next = { ...blob };
  delete next.claudeAiOauth;
  if (Object.keys(next).length === 0) return { action: 'delete' };
  return { action: 'write', next };
}

/**
 * 写后回读校验:把回读到的**原始文本**解析后与期望逐字节比对(re-stringify 后比 compact JSON,
 * 故 keychain 的 compact 存法与文件的 pretty 存法都能正确匹配)。
 *
 * 任一后端若写入被截断 / 部分写,回读文本要么 JSON.parse 失败、要么内容对不上 —— 都返 false,
 * 调用方据此抛错,杜绝「写坏了却无人察觉」(本 bug 根因)。
 *
 * @param expectedJson 期望写入的 compact JSON(= `JSON.stringify(blob)`)。
 * @param actualStoredText 回读到的原始存储文本;null 表示条目缺失 / 读不到。
 */
export function blobRoundtrips(expectedJson: string, actualStoredText: string | null): boolean {
  if (actualStoredText == null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(actualStoredText.trim());
  } catch {
    return false;
  }
  try {
    return JSON.stringify(parsed) === expectedJson;
  } catch {
    return false;
  }
}
