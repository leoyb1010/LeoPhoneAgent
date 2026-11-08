import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';

/** Bound byte-oriented TLS stream. No caller can disable certificate or hostname validation. */
export class MailTransport {
  private tls: socket.TLSSocket | null = null;
  private tcp: socket.TCPSocket | null = null;
  private chunks: Uint8Array = new Uint8Array(0);
  private failure: string = '';
  private wake: (() => void) | null = null;
  private timer: number = -1;
  private secure: boolean = false;
  private lifetime: number = -1;

  async connect(host: string, port: number, implicitTLS: boolean = true): Promise<void> {
    if (this.failure) { throw new Error(this.failure); }
    this.lifetime = setTimeout(() => { this.close(); }, 120000);
    if (implicitTLS) {
      const tls = socket.constructTLSSocketInstance();
      this.tls = tls;
      await tls.bind({ address: '0.0.0.0', port: 0, family: 1 });
      this.listenTLS(tls);
      await tls.connect({ address: { address: host, port: port, family: 1 },
        secureOptions: { protocols: [socket.Protocol.TLSv12, socket.Protocol.TLSv13] },
        skipRemoteValidation: false, timeout: 15000 });
      this.secure = true;
    } else {
      const tcp = socket.constructTCPSocketInstance();
      this.tcp = tcp;
      await tcp.bind({ address: '0.0.0.0', port: 0, family: 1 });
      tcp.on('message', (value: socket.SocketMessageInfo) => { this.receive(value.message); });
      tcp.on('close', () => { this.fail('邮件连接已关闭'); });
      tcp.on('error', () => { this.fail('邮件网络连接失败'); });
      await tcp.connect({ address: { address: host, port: port, family: 1 }, timeout: 15000 });
    }
  }

  async upgradeTLS(host: string, port: number): Promise<void> {
    const tcp = this.tcp;
    if (!tcp || this.chunks.length > 0) { throw new Error('邮件 TLS 升级状态无效'); }
    tcp.off('message'); tcp.off('close'); tcp.off('error');
    const tls = socket.constructTLSSocketInstance(tcp);
    this.tls = tls;
    this.listenTLS(tls);
    await tls.connect({ address: { address: host, port: port, family: 1 },
      secureOptions: { protocols: [socket.Protocol.TLSv12, socket.Protocol.TLSv13] },
      skipRemoteValidation: false, timeout: 15000 });
    this.secure = true;
  }

  private listenTLS(tls: socket.TLSSocket): void {
    tls.on('message', (value: socket.SocketMessageInfo) => { this.receive(value.message); });
    tls.on('close', () => { this.fail('邮件连接已关闭'); });
    tls.on('error', () => { this.fail('邮件 TLS 连接失败，已终止'); });
  }

  private receive(raw: ArrayBuffer): void {
    const bytes = new Uint8Array(raw);
    if (this.chunks.length + bytes.length > 4 * 1024 * 1024) { this.close(); return; }
    const next = new Uint8Array(this.chunks.length + bytes.length);
    next.set(this.chunks); next.set(bytes, this.chunks.length);
    this.chunks = next;
    this.wake?.();
  }

  private fail(reason: string): void { this.failure = reason; this.wake?.(); }

  async send(text: string, authentication: boolean = false): Promise<void> {
    if (authentication && !this.secure) { throw new Error('安全连接未建立，拒绝发送凭据'); }
    if (this.failure) { throw new Error(this.failure); }
    if (this.tls) { await this.tls.send(text); }
    else if (this.tcp) { await this.tcp.send({ data: text }); }
    else { throw new Error('邮箱尚未连接'); }
  }

  async line(): Promise<string> {
    while (true) {
      if (this.failure) { throw new Error(this.failure); }
      for (let i = 0; i + 1 < this.chunks.length; i++) {
        if (this.chunks[i] === 13 && this.chunks[i + 1] === 10) {
          const line = this.chunks.slice(0, i);
          this.chunks = this.chunks.slice(i + 2);
          return util.TextDecoder.create('utf-8').decodeToString(line);
        }
      }
      await this.wait();
    }
  }

  async literal(length: number): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 0 || length > 1500000) { throw new Error('邮件正文超过读取上限'); }
    while (this.chunks.length < length) { await this.wait(); }
    const result = this.chunks.slice(0, length);
    this.chunks = this.chunks.slice(length);
    return result;
  }

  private wait(): Promise<void> {
    if (this.failure) { return Promise.reject(new Error(this.failure)); }
    return new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
      this.wake = () => {
        if (this.timer >= 0) { clearTimeout(this.timer); }
        this.wake = null;
        if (this.failure) { reject(new Error(this.failure)); } else { resolve(); }
      };
      this.timer = setTimeout(() => { this.fail('邮件服务器响应超时'); }, 30000);
    });
  }

  close(): void {
    this.fail('邮件连接已结束或操作已取消');
    if (this.lifetime >= 0) { clearTimeout(this.lifetime); }
    if (this.timer >= 0) { clearTimeout(this.timer); }
    this.tls?.close().catch(() => {});
    if (!this.tls) { this.tcp?.close().catch(() => {}); }
    this.tls = null; this.tcp = null; this.chunks = new Uint8Array(0);
  }
}
