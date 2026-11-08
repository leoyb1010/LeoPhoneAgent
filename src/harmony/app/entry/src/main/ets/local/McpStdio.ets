import { common } from '@kit.AbilityKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { LinuxRuntime } from './LinuxRuntime';
import { mcpInitializeParams, mcpNotification, mcpRequest } from './AgentText';
import { ReleaseCatalog } from '../release/ReleaseCatalog';

export class McpStdioSpec {
  label: string = '';
  command: string = '';
  args: string[] = [];
  env: Record<string, string> = {};
}
const STDIO_MAX_LINE_CHARS: number = 8 * 1024 * 1024; // Matches the iOS MCP daemon line ceiling.

const STDIO_SERVER_QUEUE_BYTES: number = 32 * 1024 * 1024;
const STDIO_GLOBAL_QUEUE_BYTES: number = 64 * 1024 * 1024;
const STDIO_SERVER_QUEUE_FRAMES: number = 128;
const STDIO_GLOBAL_QUEUE_FRAMES: number = 256;

class StdioWaiter { current: () => boolean = () => true; }
class StdioPending {
  resolve: (reply: string) => void = () => {};
  reject: (error: Error) => void = () => {};
  current: () => boolean = () => true;
  deadline: number = 0;
}
export function stdioQuote(text: string): string {
  if (text.includes('\u0000')) { throw new Error('MCP启动参数含NUL字符'); }
  return "'" + text.replace(/'/g, "'\\''") + "'";
}
export function stdioExec(spec: McpStdioSpec): string {
  if (!spec.command.trim() || spec.args.length > 128) { throw new Error('MCP命令为空或参数过多'); }
  const env = Object.keys(spec.env).map((name: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { throw new Error('MCP环境变量名称无效'); }
    return stdioQuote(name + '=' + spec.env[name]);
  });
  return 'exec /bin/busybox env ' + env.concat([stdioQuote(spec.command)], spec.args.map((arg: string) => stdioQuote(arg))).join(' ');
}

/** One persistent guest pipe process per resolved server configuration. RPC callers share it, not request lifetimes. */
export class McpStdio {
  private static processes: Map<string, McpStdio> = new Map();
  private static nextId: number = 100;
  private static queuedBytes: number = 0;
  private static queuedFrames: number = 0;
  private static context: common.Context | null = null;
  private readonly owner: string = 'mcp-stdio-' + util.generateRandomUUID(true);
  private readonly marker: string = 'LEO_MCP_READY_' + util.generateRandomUUID(false);
  private readonly spec: McpStdioSpec;
  private readonly appContext: common.Context;
  private pid: number = 0;
  private stopped: boolean = false;
  private initialized: boolean = false;
  private terminalReady: boolean = false;
  private failure: string = '';
  private buffer: string = '';
  private timer: number = -1;
  private waiters: Set<StdioWaiter> = new Set();
  private pending: Map<number, StdioPending> = new Map();
  private outputQueue: string[] = [];
  private sending: boolean = false;
  // Reservations include the frame currently blocked in writeStdio, until sent or closed.
  private queuedBytes: number = 0;
  private queuedFrames: number = 0;

  private constructor(spec: McpStdioSpec, context: common.Context) { this.spec = JSON.parse(JSON.stringify(spec)) as McpStdioSpec; this.appContext = context; }
  static attachContext(context: common.Context): void { McpStdio.context = context; }

  static async request(spec: McpStdioSpec, method: string, params: string, timeout: number,
    isCurrent: () => boolean = () => true): Promise<string> {
    if (!isCurrent()) { throw new Error('MCP调用已取消'); }
    if (params.length > STDIO_MAX_LINE_CHARS) { throw new Error('MCP请求超过8MiB上限'); }
    JSON.parse(params);
    const context = McpStdio.context;
    if (!context) { throw new Error('MCP运行时缺少应用上下文'); }
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: new util.TextEncoder().encodeInto(JSON.stringify([context.filesDir, spec])) });
    let key = '';
    for (const byte of (await digest.digest()).data) { key += byte.toString(16).padStart(2, '0'); }
    if (!isCurrent()) { throw new Error('MCP调用已取消'); }
    let process = McpStdio.processes.get(key);
    let fresh = false;
    if (!process || process.stopped) {
      if (McpStdio.processes.size >= 4) { throw new Error('stdio MCP进程已达4个，请先停止一个服务器'); }
      process = new McpStdio(spec, context);
      McpStdio.processes.set(key, process);
      fresh = true;
    }
    const session = process;
    const waiter = new StdioWaiter(); waiter.current = isCurrent;
    session.waiters.add(waiter);
    if (fresh) {
      session.boot().catch((error: Error) => { session.fail(error.message || 'MCP进程启动或初始化失败'); });
    }
    try {
      const deadline = Date.now() + 180000;
      while (!session.initialized) {
        if (!isCurrent()) { throw new Error('MCP调用已取消'); }
        if (session.failure || session.stopped) { throw new Error(session.failure || 'MCP进程已停止'); }
        if (Date.now() > deadline) { throw new Error('MCP依赖准备或初始化超时'); }
        await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 30); });
      }
      return await session.rpc(method, params, timeout, isCurrent);
    } finally { session.waiters.delete(waiter); }
  }

  private wanted(): boolean { return Array.from(this.waiters).some((waiter: StdioWaiter) => waiter.current()); }
  private async boot(): Promise<void> {
    const context = this.appContext;
    await LinuxRuntime.initialize(context);
    if (this.stopped || !this.wanted()) { this.close(); return; }
    // Same lazy dependency mapping as iOS leophoneagent-mcp-cli/utils/deps.py.
    const base = this.spec.command.split('/').pop() ?? '';
    const resolver: Record<string, string> = {
      'node': 'apk add --quiet nodejs npm', 'npm': 'apk add --quiet nodejs npm', 'npx': 'apk add --quiet nodejs npm',
      'python3': 'apk add --quiet python3 py3-pip', 'pip': 'apk add --quiet python3 py3-pip',
      'uv': 'apk add --quiet python3 py3-pip && python3 -m pip install --quiet --break-system-packages uv',
      'uvx': 'apk add --quiet python3 py3-pip && python3 -m pip install --quiet --break-system-packages uv'
    };
    const install = resolver[base];
    const check = 'command -v ' + stdioQuote(this.spec.command) + ' >/dev/null 2>&1';
    const bootstrap = check + (install ? ' || { ' + install + ' >/dev/null 2>&1 && ' + check + '; }' : '');
    const prepared = await LinuxRuntime.run(context, this.owner, bootstrap, 180000, () => !this.stopped && this.wanted());
    if (prepared.exitCode !== 0) { throw new Error('MCP命令或依赖不可用'); }
    if (this.stopped || !this.wanted()) { this.close(); return; }
    // No runtime secrets are present in this command. The pipe readiness marker gates later stdin delivery.
    const script = 'printf "\\n' + this.marker + '\\n"; ' +
      'IFS= read -r LEO_MCP_EXEC; eval "$(printf %s \"$LEO_MCP_EXEC\" | /bin/busybox base64 -d)"';
    this.pid = LinuxRuntime.startStdio(this.owner, script);
    this.schedule();
    const deadline = Date.now() + 15000;
    while (!this.terminalReady) {
      if (this.failure || this.stopped) { throw new Error(this.failure || 'MCP进程已停止'); }
      if (!this.wanted() || Date.now() > deadline) { this.close(); throw new Error('MCP终端初始化已取消或超时'); }
      await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 20); });
    }
    const executable = stdioExec(this.spec);
    const payload = new util.Base64Helper().encodeToStringSync(new util.TextEncoder().encodeInto(executable)) + '\n';
    if (payload.length > 128 * 1024) { throw new Error('MCP环境或启动参数过大'); }
    await this.enqueue(payload);
    const initialized = await this.rpc('initialize', mcpInitializeParams(ReleaseCatalog.currentVersion), 60000,
      () => !this.stopped && this.wanted());
    const result = JSON.parse(initialized) as Record<string, Object>;
    if (result['error'] || !result['result']) { throw new Error('MCP初始化被服务器拒绝'); }
    await this.enqueue(mcpNotification('notifications/initialized') + '\n');
    this.initialized = true;
    AppStorage.setOrCreate('mcpStdioTick', Date.now());
    // Expanded environment is now owned only by the guest process environment.
    this.spec.env = {}; this.spec.command = ''; this.spec.args = [];
  }

  private rpc(method: string, params: string, timeout: number, isCurrent: () => boolean): Promise<string> {
    if (this.failure || this.stopped || !isCurrent()) { return Promise.reject(new Error('MCP进程已停止或调用已取消')); }
    if (this.pending.size >= 64) { return Promise.reject(new Error('MCP并发请求超过64个，请稍后重试')); }
    const id = ++McpStdio.nextId;
    return new Promise<string>((resolve: (text: string) => void, reject: (error: Error) => void) => {
      const pending = new StdioPending(); pending.resolve = resolve; pending.reject = reject;
      pending.current = isCurrent; pending.deadline = Date.now() + timeout;
      const frame = mcpRequest(id, method, params);
      this.pending.set(id, pending);
      this.enqueue(frame + '\n').catch(() => {
        this.pending.delete(id); reject(new Error('MCP请求未能完整写入'));
      });
    });
  }

  private enqueue(text: string): Promise<void> {
    if (this.stopped) { return Promise.reject(new Error(this.failure || 'MCP进程已停止')); }
    const bytes = new util.TextEncoder().encodeInto(text).byteLength;
    if (this.queuedBytes + bytes > STDIO_SERVER_QUEUE_BYTES ||
      McpStdio.queuedBytes + bytes > STDIO_GLOBAL_QUEUE_BYTES ||
      this.queuedFrames >= STDIO_SERVER_QUEUE_FRAMES || McpStdio.queuedFrames >= STDIO_GLOBAL_QUEUE_FRAMES) {
      this.fail('MCP发送队列超过安全配额，服务器已停止');
      return Promise.reject(new Error(this.failure));
    }
    this.queuedBytes += bytes; this.queuedFrames++;
    McpStdio.queuedBytes += bytes; McpStdio.queuedFrames++;
    this.outputQueue.push(text);
    if (this.sending) { return Promise.resolve(); }
    this.sending = true;
    return (async () => {
      try {
        while (this.outputQueue.length > 0) {
          const value = this.outputQueue.shift() ?? '';
          const bytes = new util.TextEncoder().encodeInto(value).byteLength;
          try {
            if (value.startsWith('{')) {
              const request = JSON.parse(value) as Record<string, Object>;
              if (request['method'] && typeof request['id'] === 'number' && !this.pending.has(request['id'] as number)) { continue; }
            }
            // Write at UTF-8 character boundaries under LinuxRuntime's 4096-byte ceiling.
            const characters = Array.from(value);
            for (let offset = 0; offset < characters.length; offset += 700) {
              if (this.stopped) { throw new Error('MCP进程已停止'); }
              const chunk = characters.slice(offset, offset + 700).join('');
              const size = new util.TextEncoder().encodeInto(chunk).byteLength;
              const deadline = Date.now() + 30000;
              let written = 0;
              while (written === 0) {
                if (this.stopped || Date.now() > deadline) { throw new Error('MCP输入背压超时或已取消'); }
                written = LinuxRuntime.writeStdio(this.owner, this.pid, chunk);
                if (written !== 0 && written !== size) { throw new Error('MCP输入发生部分写入'); }
                if (written === 0) { await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 5); }); }
              }
              await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 0); });
            }
          } finally {
            // close() releases every reservation atomically, including this in-flight frame.
            if (!this.stopped) {
              this.queuedBytes -= bytes; this.queuedFrames--;
              McpStdio.queuedBytes -= bytes; McpStdio.queuedFrames--;
            }
          }
        }
      } catch (_err) { this.fail('MCP请求写入失败，进程已停止以避免请求截断'); throw new Error('MCP写入失败'); }
      finally { this.sending = false; }
    })();
  }

  private schedule(): void {
    if (this.stopped) { return; }
    this.timer = setTimeout(() => { this.pump(); }, this.pending.size > 0 || !this.initialized ? 20 : 200);
  }
  private pump(): void {
    if (this.stopped) { return; }
    try {
      const output = LinuxRuntime.poll(this.owner, this.pid);
      if (output.truncated) { throw new Error('MCP输出超过缓冲上限'); }
      this.buffer += output.text;
      if (!this.terminalReady) {
        const ready = this.buffer.indexOf(this.marker + '\n');
        if (ready >= 0) { this.buffer = this.buffer.slice(ready + this.marker.length + 1); this.terminalReady = true; }
      }
      if (this.terminalReady) {
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
          if (newline > STDIO_MAX_LINE_CHARS) { throw new Error('MCP单条输出过长'); }
          const line = this.buffer.slice(0, newline).replace(/\r$/, ''); this.buffer = this.buffer.slice(newline + 1);
          this.line(line);
          if (this.stopped) { return; }
          newline = this.buffer.indexOf('\n');
        }
      }
      if (this.buffer.length > STDIO_MAX_LINE_CHARS) { throw new Error('MCP单条输出过长'); }
      this.pending.forEach((pending: StdioPending, id: number) => {
        if (!pending.current() || Date.now() >= pending.deadline) {
          this.pending.delete(id);
          const reason = pending.current() ? 'MCP请求超时' : 'MCP调用已取消';
          pending.reject(new Error(reason));
          const params: Record<string, Object> = { 'requestId': id, 'reason': reason };
          this.enqueue(JSON.stringify({ 'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': params }) + '\n').catch(() => {});
        }
      });
      if (output.exited) { this.pid = 0; this.fail('MCP服务器进程已退出（' + output.exitCode + '）'); return; }
      if (!this.initialized && !this.wanted()) { this.close(); return; }
    } catch (_err) { this.fail('MCP进程输出或会话状态异常'); return; }
    this.schedule();
  }
  private line(line: string): void {
    try {
      const parsed = JSON.parse(line) as Object;
      if (Array.isArray(parsed)) { (parsed as Object[]).slice(0, 100).forEach((item: Object) => { this.reply(item); }); }
      else { this.reply(parsed); }
    } catch (_err) { /* Non-protocol stdout is ignored; stderr is carried on its own native pipe. */ }
  }
  private reply(value: Object): void {
    const message = value as Record<string, Object>;
    if (!message || message['jsonrpc'] !== '2.0') { return; }
    if (Object.keys(message).includes('method')) {
      if (message['id'] !== undefined) {
        const response: Record<string, Object> = { 'jsonrpc': '2.0', 'id': message['id'] };
        if (message['method'] === 'ping') { const result: Record<string, Object> = {}; response['result'] = result; }
        else { const error: Record<string, Object> = { 'code': -32601, 'message': 'Client capability not available' }; response['error'] = error; }
        this.enqueue(JSON.stringify(response) + '\n').catch(() => {});
      }
      return;
    }
    const id = message['id'];
    if (typeof id !== 'number' || (!Object.keys(message).includes('result') && !Object.keys(message).includes('error'))) { return; }
    const pending = this.pending.get(id);
    if (!pending) { return; }
    this.pending.delete(id);
    if (!pending.current()) { pending.reject(new Error('MCP调用已取消')); return; }
    pending.resolve(JSON.stringify(message));
  }
  private fail(reason: string): void {
    if (this.stopped) { return; }
    this.failure = reason;
    this.pending.forEach((pending: StdioPending) => { pending.reject(new Error(reason)); }); this.pending.clear(); this.close();
  }
  close(): void {
    if (this.stopped) { return; }
    this.stopped = true;
    if (this.timer >= 0) { clearTimeout(this.timer); }
    this.pending.forEach((pending: StdioPending) => { pending.reject(new Error(this.failure || 'MCP进程已停止')); }); this.pending.clear();
    AppStorage.setOrCreate('mcpStdioTick', Date.now());
    McpStdio.queuedBytes -= this.queuedBytes; McpStdio.queuedFrames -= this.queuedFrames;
    this.queuedBytes = 0; this.queuedFrames = 0;
    this.outputQueue = []; this.buffer = ''; this.spec.env = {};
    if (this.pid > 0) { LinuxRuntime.detach(this.owner, this.pid).catch(() => {}); this.pid = 0; }
    McpStdio.processes.forEach((value: McpStdio, key: string) => { if (value === this) { McpStdio.processes.delete(key); } });
  }
  static running(label: string): boolean { return Array.from(McpStdio.processes.values()).some((process: McpStdio) => process.spec.label === label && process.initialized && !process.stopped); }
  static closeLabel(label: string): void { McpStdio.processes.forEach((process: McpStdio) => { if (process.spec.label === label) { process.close(); } }); }
  static closeAll(): void { McpStdio.processes.forEach((process: McpStdio) => { process.close(); }); }
}
