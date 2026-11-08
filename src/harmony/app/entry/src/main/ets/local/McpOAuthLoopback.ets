import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { oauthRedirect } from './McpOAuthProtocol';

/** RFC 8252 loopback callback only. No token or verifier is served over HTTP. */
export class McpOAuthLoopback {
  private server: socket.TCPSocketServer | null = null;
  private connections: Set<socket.TCPSocketConnection> = new Set();
  private closed: boolean = false;
  private accepted: boolean = false;

  async start(redirectURI: string, accept: (callback: string) => boolean, receive: (callback: string) => void): Promise<void> {
    const redirect = oauthRedirect(redirectURI);
    if (redirect.protocol !== 'http:') { return; }
    const address = redirect.hostname === 'localhost' ? '127.0.0.1' : redirect.hostname.replace(/^\[|\]$/g, '');
    const server = socket.constructTCPSocketServerInstance(); this.server = server;
    server.on('connect', (connection: socket.TCPSocketConnection) => {
      if (this.closed || this.connections.size >= 8) { connection.close().catch(() => {}); return; }
      this.connections.add(connection);
      let buffer = ''; let consumed = false;
      const decoder = util.TextDecoder.create('utf-8');
      const timer = setTimeout(() => { connection.close().catch(() => {}); this.connections.delete(connection); }, 10000);
      connection.on('close', () => { clearTimeout(timer); this.connections.delete(connection); });
      connection.on('error', () => { clearTimeout(timer); this.connections.delete(connection); connection.close().catch(() => {}); });
      connection.on('message', (message: socket.SocketMessageInfo) => {
        if (consumed || this.closed) { return; }
        buffer += decoder.decodeToString(new Uint8Array(message.message), { stream: true });
        if (buffer.length > 16384) { consumed = true; connection.close().catch(() => {}); return; }
        if (!buffer.includes('\r\n\r\n')) { return; }
        consumed = true;
        const request = /^GET (\/[^\s#]*) HTTP\/1\.[01]$/.exec(buffer.split('\r\n')[0]);
        const callback = request ? redirect.protocol + '//' + redirect.host + request[1] : '';
        const valid = !this.accepted && callback.length > 0 && accept(callback);
        if (valid) { this.accepted = true; }
        const text = valid ? 'LeoBot authorization received. You can return to the app.' : 'Invalid or expired authorization callback.';
        const response = 'HTTP/1.1 ' + (valid ? '200 OK' : '400 Bad Request') + '\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: ' + text.length + '\r\n\r\n' + text;
        connection.send({ data: response }).catch(() => {}).finally(() => {
          connection.close().catch(() => {});
          if (valid && !this.closed && accept(callback)) { receive(callback); }
        });
      });
    });
    try {
      await server.listen({ address: address, port: Number(redirect.port), family: address.includes(':') ? 2 : 1 });
      if (this.closed) { await server.close(); }
    } catch (_err) { this.close(); throw new Error('OAuth本机回调端口不可用，请检查端口或更改回调地址'); }
  }
  close(): void {
    this.closed = true;
    this.connections.forEach((connection: socket.TCPSocketConnection) => { connection.close().catch(() => {}); }); this.connections.clear();
    this.server?.close().catch(() => {}); this.server = null;
  }
}
