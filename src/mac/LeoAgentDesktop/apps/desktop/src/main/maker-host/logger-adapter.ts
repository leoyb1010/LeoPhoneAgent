/**
 * Desktop Logger 实现 —— 包装现有 createLogger() 为 maker-core Logger 接口。
 *
 * 格式约定 (block 风格):
 *   [ts] [LEVEL] [scope] msg
 *     key1 : value1
 *     key2 : value2
 *   ────────────────────────────────────────────────────
 *
 * 每条日志都是一个完整的视觉块: 标题原样, ctx 缩进, 收尾来一行 dash 作为视觉边界。
 * 整块是单次 emit() 写入,所以只产生一个 [ts] [LEVEL] [scope] 前缀。
 *
 * 例外: 当 msg 本身就是 dash 分隔符或空白时,直接透传不再装饰。
 */

import type { Logger } from '@cindy/maker-core';

import { createLogger, getLogLevel } from '../logger.js';

const BLOCK_WIDTH = 72;
const DASH = '─';
const CLOSING_LINE = DASH.repeat(BLOCK_WIDTH);

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;  // 不加引号,字符串值经常占多数,加引号反而吵
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return v.stack ?? v.message;
  // 对象/数组:pretty JSON,再把每行加 4 空格缩进对齐(首行不加,跟在 key: 后面)
  try {
    const json = JSON.stringify(v, null, 2);
    const lines = json.split('\n');
    if (lines.length === 1) return json;
    return lines.map((l, i) => i === 0 ? l : '    ' + l).join('\n');
  } catch {
    return String(v);
  }
}

function formatCtx(ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return '';
  const keys = Object.keys(ctx);
  if (keys.length === 0) return '';
  // key 列右对齐,看起来像表格
  const keyWidth = Math.max(...keys.map((k) => k.length));
  return '\n' + keys.map((k) => `  ${k.padEnd(keyWidth)} : ${formatValue(ctx[k])}`).join('\n');
}

function isDecorationOnly(msg: string): boolean {
  // msg 已经是分隔条/装饰线时不要再加收尾装饰
  return /^[─\s=*-]+$/.test(msg);
}

function formatBlock(msg: string, ctx?: Record<string, unknown>): string {
  if (isDecorationOnly(msg)) return msg;  // 透传纯装饰行
  return `${msg}${formatCtx(ctx)}\n${CLOSING_LINE}`;
}

/**
 * 判断当前全局日志级别是否会让 debug 行实际落盘。
 *
 * 用途: 给消费方(典型: anthropic-compat-proxy)在做"昂贵的 debug 准备工作"
 * (例如 tee 响应流到内存做完整 body dump) 之前提前判断,info 级别下直接跳过,
 * 不浪费 CPU/内存。注意: trace 级别比 debug 更低, 自然也算 enabled。
 */
function debugLevelEnabled(): boolean {
  const lvl = getLogLevel();
  return lvl === 'trace' || lvl === 'debug';
}

export function createMakerLogger(scope = 'maker'): Logger {
  const log = createLogger(scope);
  return {
    trace: (msg, ctx) => log.trace?.(formatBlock(msg, ctx)),
    debug: (msg, ctx) => log.debug(formatBlock(msg, ctx)),
    info: (msg, ctx) => log.info(formatBlock(msg, ctx)),
    warn: (msg, ctx) => log.warn(formatBlock(msg, ctx)),
    error: (msg, ctx) => log.error(formatBlock(msg, ctx)),
    fatal: (msg, ctx) => log.error(formatBlock(`[FATAL] ${msg}`, ctx)),
    child: (sub) => createMakerLogger(`${scope}/${sub}`),
    // ProxyLogger 用的可选钩子 —— maker-core/Logger 接口本身没声明这个方法,
    // 但 TypeScript 结构类型允许多出来的方法,proxy 那边按 isDebugEnabled?.() 调,
    // 没人用就无副作用。
    isDebugEnabled: debugLevelEnabled,
  } as Logger & { isDebugEnabled: () => boolean };
}

export const desktopMakerLogger = createMakerLogger('maker');
