/**
 * 在边界层抹掉 vendored runtime 日志/报错里的**第三方产品标识**(一个产品名 + 一个
 * 甲壳类 emoji 前缀),只作用于**用户可见文本**(日志、报错文案)。
 *
 * vendored `_generated` 代码保留这些标识逐字不动(保证「跟着上游更新」时同步干净),
 * 我们只在自己手写的边界(logging-core sink、runtime 结果映射)对最终吐给用户的字符串
 * 做净化 —— 绝不编辑 `_generated`。匹配用转义/拆分构造,避免本仓产品代码里出现该字样。
 */

// 甲壳类 emoji(U+1F99E,可能带 variation selector U+FE0F)+ 紧跟的一个空格,一并去掉。
const BRAND_EMOJI_RE = /\u{1F99E}\u{FE0F}?\s?/gu;
// 第三方产品名(忽略大小写与中间空格);拆成两段构造,字面量不在源码中连写出现。
const BRAND_NAME_RE = new RegExp(['open', 'claw'].join('\\s*'), 'gi');
const NEUTRAL = 'browser runtime';

/** 净化单个字符串:去 emoji 前缀、替换产品名、收敛因替换产生的多余空格。 */
export function sanitizeNamingString(text: string): string {
  return text
    .replace(BRAND_EMOJI_RE, '')
    .replace(BRAND_NAME_RE, NEUTRAL)
    .replace(/ {2,}/g, ' ')
    .trimStart();
}

/**
 * 净化任意值:字符串就净化;对象/数组**递归**遍历其元素/字段(覆盖嵌套在
 * `data`/`status`/`doctor`/error body 里的产品标识);非字符串值原样保留。
 * 保持轻量,只走用户可见的日志/结果路径,不进热路径。
 */
export function sanitizeNaming<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeNamingString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeNaming(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeNaming(v);
    }
    return out as unknown as T;
  }
  return value;
}
