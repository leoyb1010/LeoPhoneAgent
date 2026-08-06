/**
 * client — desktop main 侧的 file-service RPC client。
 *
 * 传输解耦:构造时注入 duck-typed `FileServiceStream`(形状对齐
 * maker-remote-ssh 的 ExecStreamHandle,但这里不 import 那个包——eslint
 * 强制),desktop 侧把 `host.execStream(...)` 的返回值直接递进来即可;
 * 测试用内存流 fake。
 *
 * 生命周期:
 *  - `connect()` 发 handshake 并校验 schema;不匹配抛 SCHEMA_MISMATCH 错误
 *    (caller 捕获后走重推 bundle → 重连)。
 *  - 流关闭(onClose / onError)→ 所有 pending 请求以 CHANNEL_CLOSED reject,
 *    client 进入 dead 态,后续 request 立即 reject;caller 需要新建 client。
 *  - 每请求默认 15s 超时(文件 IO 在远端是本地盘,超时说明链路挂了)。
 */

import { NdjsonLineDecoder, encodeNdjsonFrame } from './codec.js';
import {
  FILE_SERVICE_SCHEMA_VERSION,
  isFsRpcEvent,
  isFsRpcResponse,
  type FsRpcEvent,
  type FsRpcMethods,
} from './protocol.js';

/** 与 ExecStreamHandle 结构兼容的最小传输面。 */
export interface FileServiceStream {
  write(data: string | Buffer): void;
  onStdout(cb: (chunk: string) => void): () => void;
  /** 原始字节流(可选)。transport 若提供必须优先消费:per-chunk toString
   *  会把跨 chunk 撕裂的多字节 UTF-8 序列换成 U+FFFD——JSON 照样 parse 得过,
   *  但中文文件内容/文件名被静默损坏。decoder 内置 StringDecoder 正确跨
   *  chunk 续接。 */
  onStdoutBytes?(cb: (chunk: Buffer) => void): () => void;
  onStderr(cb: (chunk: string) => void): () => void;
  onClose(cb: (info: { code: number | null; signal: string | null }) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  kill(signal?: string): void;
}

export interface FileServiceClientLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface FileServiceClientOptions {
  stream: FileServiceStream;
  logger?: FileServiceClientLogger;
  /** 单请求超时,默认 15_000ms。 */
  requestTimeoutMs?: number;
}

/** request() 抛出的错误:code 透传 daemon 的 FsRpcErrorCode 或本地传输码。 */
export class FileServiceRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FileServiceRpcError';
    this.code = code;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class FileServiceClient {
  private readonly stream: FileServiceStream;
  private readonly log?: FileServiceClientLogger;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(evt: FsRpcEvent) => void>();
  private readonly disposers: Array<() => void> = [];
  private nextId = 1;
  private dead: Error | null = null;

  constructor(opts: FileServiceClientOptions) {
    this.stream = opts.stream;
    this.log = opts.logger;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;

    const decoder = new NdjsonLineDecoder({
      onCorruptLine: (line, err) =>
        this.log?.warn('file-service corrupt frame', err.message, line.slice(0, 120)),
    });

    // 优先字节流:见 FileServiceStream.onStdoutBytes 注释(多字节撕裂防护);
    // 老 transport / 测试 fake 无 bytes 通道时回退文本流。
    const consumeChunk = (chunk: string | Buffer): void => {
      for (const frame of decoder.push(chunk)) this.consume(frame);
    };
    this.disposers.push(
      this.stream.onStdoutBytes
        ? this.stream.onStdoutBytes(consumeChunk)
        : this.stream.onStdout(consumeChunk),
      this.stream.onStderr((chunk) => {
        const text = chunk.trim();
        if (text) this.log?.debug('file-service stderr', text.slice(0, 500));
      }),
      this.stream.onClose(({ code, signal }) => {
        this.markDead(new FileServiceRpcError('CHANNEL_CLOSED', `file-service exited (code=${code} signal=${signal})`));
      }),
      this.stream.onError((err) => {
        this.markDead(new FileServiceRpcError('CHANNEL_ERROR', String(err.message ?? err)));
      }),
    );
  }

  /** 流是否已死(daemon 退出 / 通道错误)。死了就该丢弃这个 client 重建。 */
  get isDead(): boolean {
    return this.dead !== null;
  }

  /** 握手 + schema 校验。连接后必须先调;失败时 caller 负责销毁 client。 */
  async connect(): Promise<FsRpcMethods['handshake']['result']> {
    const info = await this.request('handshake', {
      clientSchemaVersion: FILE_SERVICE_SCHEMA_VERSION,
    });
    if (info.schemaVersion !== FILE_SERVICE_SCHEMA_VERSION) {
      throw new FileServiceRpcError(
        'SCHEMA_MISMATCH',
        `daemon schema=${info.schemaVersion} client schema=${FILE_SERVICE_SCHEMA_VERSION}`,
      );
    }
    return info;
  }

  /** 类型安全的 RPC 调用。 */
  request<M extends keyof FsRpcMethods>(
    method: M,
    params: FsRpcMethods[M]['params'],
  ): Promise<FsRpcMethods[M]['result']> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FileServiceRpcError('TIMEOUT', `${String(method)} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.stream.write(encodeNdjsonFrame({ id, method, params }));
    });
  }

  /** 订阅 daemon 事件帧(搜索流 / watch)。返回退订函数。 */
  onEvent(cb: (evt: FsRpcEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** 主动关闭:杀远端进程 + 挂断所有 pending。幂等。 */
  dispose(): void {
    this.markDead(new FileServiceRpcError('DISPOSED', 'client disposed'));
    try {
      this.stream.kill();
    } catch {
      // channel 可能已关,忽略
    }
  }

  private consume(frame: unknown): void {
    if (isFsRpcResponse(frame)) {
      const entry = this.pending.get(frame.id);
      if (!entry) return; // 超时后迟到的响应
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.ok) entry.resolve(frame.result);
      else entry.reject(new FileServiceRpcError(frame.error.code, frame.error.message));
      return;
    }
    if (isFsRpcEvent(frame)) {
      for (const cb of this.eventListeners) cb(frame);
      return;
    }
    this.log?.warn('file-service unexpected frame', JSON.stringify(frame).slice(0, 120));
  }

  private markDead(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const d of this.disposers.splice(0)) d();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    this.eventListeners.clear();
  }
}
