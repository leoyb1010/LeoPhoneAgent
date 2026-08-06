import { z } from 'zod';

/**
 * string → JSON.parse 出的 object；非 string、或 parse 失败时原样返回，
 * 交给下游 record 校验报原本的错（不吞坏数据）。
 */
function coerceStringifiedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Generic `call_tool({ name, args })` 入口里 `args` 字段的 schema。
 *
 * 背景（GitHub issue #350）：个别 MCP caller —— 实测是 Claude Code 的 in-process
 * SDK MCP bridge —— 在转发「嵌套对象里含超长字符串」的 tool-call 时，会把整个
 * `args` 先 `JSON.stringify` 成字符串再发过来。结果进入 MCP SDK 的入参校验时
 * `args` 是 string 而非 object，直接在 entry schema 层报 `-32602 invalid_type
 * (expected record)`，业务 registry 根本没机会跑。所有走 generic
 * `call_tool({ name, args })` 的 server 都可能中招，不限 scheduler。
 *
 * 这里用 `z.preprocess` 做兜底：`args` 若是 string 先 `JSON.parse` 还原成 object
 * 再交给 record 校验；已经是 object 则原样透传；parse 失败（真的不是 JSON）仍交给
 * record 报原来的错。
 *
 * ⚠️ 关键不变量：`.describe()` 必须放在【内层 record】上（而非 preprocess 外层），
 * 否则 MCP SDK 暴露给模型的 JSON Schema 会漂移。描述文案会在传入 description 末尾
 * 追加固定的 `OBJECT_HINT` 反例后缀，明确提示模型传对象本身、不要 stringify（降低
 * issue #350 复发概率）。这会改变模型看到的工具定义 / Anthropic prompt cache 前缀
 * （见 CLAUDE.md 规则 10）：改动本函数或 OBJECT_HINT 务必跑
 * `__tests__/json-object-arg.test.ts` 的 schema 快照断言并同步更新预期。
 */
/** 固定反例后缀：明确提示模型 `args` 传对象本身，别 JSON.stringify 成字符串。 */
const OBJECT_HINT = '（传 JSON 对象本身，不要序列化成字符串）';

export function jsonObjectArg(description: string) {
  return z.preprocess(
    coerceStringifiedJson,
    z.record(z.string(), z.unknown()).describe(`${description}${OBJECT_HINT}`),
  );
}
