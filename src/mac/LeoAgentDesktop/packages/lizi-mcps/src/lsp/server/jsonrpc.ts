import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

import type { LiziMcpLogger } from '../../types.js';

export type JsonRpcId = number | string;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcRequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type JsonRpcNotificationHandler = (params: unknown) => Promise<void> | void;

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function classifyStderrLine(line: string): 'debug' | 'warn' | 'error' {
  const plain = line.replace(ANSI_ESCAPE_RE, '').trim();
  if (!plain) return 'debug';
  if (/\b(warn|warning)\b/i.test(plain)) return 'warn';
  if (/\b(error|fatal|panic|exception|unhandled|aborted)\b/i.test(plain) || /^error:/i.test(plain)) {
    return 'error';
  }
  return 'debug';
}

function encodeMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function findHeaderEnd(buffer: Buffer): number {
  return buffer.indexOf(HEADER_SEPARATOR);
}

function parseContentLength(header: string): number {
  for (const line of header.split('\r\n')) {
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
    if (match) return Number(match[1]);
  }
  return -1;
}

/**
 * JSON-RPC 2.0 client for LSP stdio transport.
 *
 * LSP frames messages with `Content-Length` headers over stdout/stdin. This
 * class owns framing, pending request correlation, stderr logging, and
 * graceful process close.
 */
export class LspJsonRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();
  private readonly notificationHandlers = new Map<string, JsonRpcNotificationHandler>();
  private closed = false;

  constructor(
    private readonly opts: {
      command: string;
      args: string[];
      spawnOptions: SpawnOptionsWithoutStdio;
      logger: LiziMcpLogger;
      requestTimeoutMs?: number;
      maxMessageBytes?: number;
    },
  ) {}

  spawnProcess(): void {
    if (this.child) throw new Error('LSP JSON-RPC client already spawned');
    if (this.closed) throw new Error('LSP JSON-RPC client cannot spawn after close');

    this.opts.logger.info('lsp spawn', {
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.spawnOptions.cwd,
    });

    const child = spawn(this.opts.command, this.opts.args, {
      ...this.opts.spawnOptions,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    });
    this.child = child;

    child.on('error', (err) => {
      this.opts.logger.error('lsp child error', { message: err.message });
      this.failTransport(err);
    });
    child.on('exit', (code, signal) => {
      this.opts.logger.info('lsp child exited', { code, signal, closed: this.closed });
      if (!this.closed) {
        this.failTransport(new Error(`language server exited unexpectedly (${signal ?? code ?? 'unknown'})`));
      }
    });

    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));

    child.stderr.setEncoding('utf8');
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      const idx = stderrBuffer.lastIndexOf('\n');
      if (idx === -1) return;
      const lines = stderrBuffer.slice(0, idx).split('\n');
      stderrBuffer = stderrBuffer.slice(idx + 1);
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '').trim();
        if (!line) continue;
        this.opts.logger[classifyStderrLine(line)]('lsp stderr', { line: line.slice(0, 2_000) });
      }
    });
  }

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.closed) {
      return Promise.reject(new Error(`LSP request ${method} after close`));
    }
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error(`LSP request ${method}: stdin unavailable`));
    }

    const id = this.nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const payload = encodeMessage({ jsonrpc: '2.0', id, method, params });

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.child!.stdin.write(payload, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child?.stdin.writable) return;
    this.child.stdin.write(encodeMessage({ jsonrpc: '2.0', method, params }), (err) => {
      if (err) this.opts.logger.warn('LSP notification write failed', { method, message: err.message });
    });
  }

  onRequest(method: string, handler: JsonRpcRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: JsonRpcNotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  async close(reason = 'LspJsonRpcClient.close()'): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const err = new Error(`LSP client closed: ${reason}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();

    const child = this.child;
    this.child = null;
    if (!child) return;

    try {
      child.stdin.end();
    } catch (e) {
      this.opts.logger.debug('lsp stdin.end failed', { message: e instanceof Error ? e.message : String(e) });
    }

    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch (e) {
        this.opts.logger.debug('lsp SIGTERM failed', { message: e instanceof Error ? e.message : String(e) });
      }
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill();
          } catch {
            // ignore
          }
        }
        resolve();
      }, 1_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    const maxBytes = this.opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

    while (this.stdoutBuffer.length > 0) {
      const headerEnd = findHeaderEnd(this.stdoutBuffer);
      if (headerEnd < 0) return;

      const header = this.stdoutBuffer.subarray(0, headerEnd).toString('ascii');
      const contentLength = parseContentLength(header);
      if (contentLength < 0) {
        this.failTransport(new Error('LSP frame missing Content-Length header'));
        return;
      }
      if (contentLength > maxBytes) {
        this.failTransport(new Error(`LSP frame exceeds max size (${contentLength} > ${maxBytes})`));
        return;
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      const frameEnd = bodyStart + contentLength;
      if (this.stdoutBuffer.length < frameEnd) return;

      const body = this.stdoutBuffer.subarray(bodyStart, frameEnd).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(frameEnd);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      this.opts.logger.warn('invalid LSP JSON message', {
        message: err instanceof Error ? err.message : String(err),
        preview: body.slice(0, 200),
      });
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const record = msg as Record<string, unknown>;
    if ('id' in record && ('result' in record || 'error' in record)) {
      this.handleResponse(record);
      return;
    }
    if ('id' in record && typeof record.method === 'string') {
      void this.handleServerRequest(record as { id: JsonRpcId; method: string; params?: unknown });
      return;
    }
    if (typeof record.method === 'string') {
      void this.handleNotification(record.method, record.params);
    }
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) {
      this.opts.logger.warn('LSP response for unknown id', { id });
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    const error = msg.error as JsonRpcErrorObject | undefined;
    if (error) {
      const err = new Error(`LSP ${pending.method} error ${error.code}: ${error.message}`);
      Object.assign(err, { code: error.code, data: error.data });
      pending.reject(err);
      return;
    }
    pending.resolve(msg.result);
  }

  private async handleServerRequest(msg: { id: JsonRpcId; method: string; params?: unknown }): Promise<void> {
    const handler = this.requestHandlers.get(msg.method);
    try {
      const result = handler ? await handler(msg.params) : null;
      this.writeRaw({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      this.writeRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    const handler = this.notificationHandlers.get(method);
    if (!handler) {
      this.opts.logger.debug('unhandled LSP notification', { method });
      return;
    }
    try {
      await handler(params);
    } catch (err) {
      this.opts.logger.warn('LSP notification handler failed', {
        method,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private writeRaw(payload: unknown): void {
    if (this.closed || !this.child?.stdin.writable) return;
    this.child.stdin.write(encodeMessage(payload), (err) => {
      if (err) this.opts.logger.warn('LSP response write failed', { message: err.message });
    });
  }

  private failTransport(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    void this.close(`transport failure: ${err.message}`);
  }
}
