/**
 * codec — NDJSON 行解码器(与 maker-cc-manager 的 codec 同思路,独立实现
 * 避免包间依赖;两者协议不同,共享代码没有净收益)。
 *
 * 要点:
 *  - chunk 边界与行边界无关,partial tail 跨 push 缓冲。
 *  - UTF-8 安全:SSH chunk 可能把多字节字符劈开,Buffer 输入走 StringDecoder
 *    持有不完整序列;string 输入(ExecStreamHandle.onStdout 已解码)直通——
 *    该路径的 UTF-8 边界安全由上游保证。
 *  - 坏行不打断流:JSON.parse 失败走 onCorruptLine 回调(记日志),继续。
 *  - OOM guard:无换行的流最多累积 MAX_BUFFER_CHARS,超限清空并报告。
 */

import { StringDecoder } from 'node:string_decoder';

export interface NdjsonLineDecoderOptions {
  /** 单行 JSON.parse 失败时回调(caller 记日志后忽略)。 */
  onCorruptLine?: (line: string, error: Error) => void;
}

/**
 * 最大未解析缓冲(字符数)。合法单帧上限是 readFile 的 2 MiB 文本(JSON
 * 转义后 <8M chars),16M 留足余量;超过说明流坏了,丢弃并报告。
 */
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

export class NdjsonLineDecoder {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly onCorruptLine?: (line: string, error: Error) => void;

  constructor(opts: NdjsonLineDecoderOptions = {}) {
    this.onCorruptLine = opts.onCorruptLine;
  }

  /** 喂一段字节/文本,返回其中完成的 JSON 值(逐行 parse)。 */
  push(chunk: string | Buffer): unknown[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer += text;
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      const dropped = this.buffer;
      this.buffer = '';
      this.onCorruptLine?.(
        `${dropped.slice(0, 200)}…(${dropped.length} chars)`,
        new Error(`ndjson buffer exceeded ${MAX_BUFFER_CHARS} chars without newline`),
      );
      return [];
    }
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch (err) {
        this.onCorruptLine?.(line, err as Error);
      }
    }
    return out;
  }
}

/** 单帧编码:JSON + 换行。两端共用,保证永不产出内嵌裸换行。 */
export function encodeNdjsonFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
