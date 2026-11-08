import { HarnessClient } from '../net/HarnessClient';

/** Local bundled viewer gets SDP/ICE only. Relay credentials never enter the Web process. */
export class ScreenSessionBridge {
  client: HarnessClient | null = null;
  allowControl: boolean = false;
  onReply: (text: string) => void = () => {};
  private sessionId: string = '';
  private closed: boolean = false;
  private opening: boolean = false;
  private revision: number = 0;
  onSuspend: () => void = () => {};
  resume(): void { this.closed = false; }

  postMessage(raw: string): void {
    if (this.closed || raw.length > 128 * 1024) { return; }
    try {
      const request = JSON.parse(raw) as Record<string, Object>;
      const id = Number(request['id']);
      if (!Number.isSafeInteger(id) || id < 1) { return; }
      this.perform(`${request['op'] ?? ''}`, request['body'] as Record<string, Object>).then((result: Object) => {
        if (!this.closed) { this.reply(id, result, ''); }
      }).catch((err: Error) => {
        if (!this.closed) { this.reply(id, '', err.message.slice(0, 500)); }
      });
    } catch (_err) {}
  }

  private reply(id: number, result: Object, error: string): void {
    const payload: Record<string, Object> = { 'id': id, 'result': result, 'error': error };
    this.onReply(JSON.stringify(payload));
  }

  private async perform(op: string, body: Record<string, Object>): Promise<Object> {
    const client = this.client;
    if (!client) { throw new Error('远程连接尚未准备好'); }
    if (op === 'preflight') { return await client.screenPreflight(); }
    if (op === 'close') {
      const old = this.sessionId; this.sessionId = '';
      if (old) { await client.closeScreen(old); }
      return true;
    }
    if (op === 'open') {
      if (this.opening || this.sessionId) { throw new Error('屏幕连接正在建立或已打开'); }
      this.opening = true;
      const revision = this.revision;
      try {
        const reply = await client.openScreen(`${body['offer'] ?? ''}`, this.allowControl);
        const session = `${reply['session_id'] ?? ''}`;
        if (!/^scr_[A-Za-z0-9-]{1,100}$/.test(session)) { throw new Error('Mac 返回的屏幕会话无效'); }
        if (this.closed || revision !== this.revision) { await client.closeScreen(session); throw new Error('屏幕页已关闭'); }
        this.sessionId = session;
        return reply;
      } finally { this.opening = false; }
    }
    if (op === 'ice') {
      if (!this.sessionId) { throw new Error('屏幕会话尚未建立'); }
      const candidates = body['candidates'];
      if (!Array.isArray(candidates) || candidates.length > 50) { throw new Error('ICE 数据无效'); }
      await client.screenCandidates(this.sessionId, candidates as Object[]);
      return true;
    }
    throw new Error('未开放的屏幕桥操作');
  }

  close(): Promise<void> {
    this.closed = true;
    this.revision++;
    this.onSuspend();
    this.allowControl = false;
    const session = this.sessionId;
    const client = this.client;
    this.sessionId = '';
    if (session && client) { return client.closeScreen(session).catch(() => {}); }
    return Promise.resolve();
  }
}

export class ScreenSessionRegistry {
  private static viewers: Set<ScreenSessionBridge> = new Set();
  static add(bridge: ScreenSessionBridge): void { ScreenSessionRegistry.viewers.add(bridge); }
  static remove(bridge: ScreenSessionBridge): void { bridge.close(); ScreenSessionRegistry.viewers.delete(bridge); }
  static suspend(): Promise<void> {
    return Promise.all(Array.from(ScreenSessionRegistry.viewers).map((bridge: ScreenSessionBridge) => bridge.close())).then(() => {});
  }
  static resume(): void { ScreenSessionRegistry.viewers.forEach((bridge: ScreenSessionBridge) => { bridge.resume(); }); }
}
