import { http } from '@kit.NetworkKit';
import { oauthHTTPS } from './McpOAuthProtocol';

export class McpOAuthJSON { code: number = 0; value: Record<string, Object> = {}; }
/** Discovery/registration/token traffic never inherits MCP headers, cookies or bearer tokens. */
export class McpOAuthNetwork {
  private requests: Set<http.HttpRequest> = new Set();
  cancelled: boolean = false;
  cancel(): void {
    this.cancelled = true; this.requests.forEach((request: http.HttpRequest) => { request.destroy(); }); this.requests.clear();
  }
  private active(isCurrent: () => boolean): boolean {
    try { return !this.cancelled && isCurrent(); } catch (_err) { return false; }
  }
  async json(endpoint: string, method: http.RequestMethod = http.RequestMethod.GET, body: string = '',
    contentType: string = 'application/json', isCurrent: () => boolean = () => true): Promise<McpOAuthJSON> {
    oauthHTTPS(endpoint);
    if (!this.active(isCurrent)) { throw new Error('MCP OAuth请求已取消'); }
    const request = http.createHttp(); this.requests.add(request);
    const timer = setInterval(() => { if (!this.active(isCurrent)) { request.destroy(); } }, 50);
    try {
      const options: http.HttpRequestOptions = {
        method: method, header: { 'Accept': 'application/json', 'Content-Type': contentType },
        expectDataType: http.HttpDataType.STRING, usingCache: false, maxRedirects: 0, maxLimit: 256 * 1024,
        connectTimeout: 10000, readTimeout: 15000
      };
      if (method !== http.RequestMethod.GET) { options.extraData = body; }
      const response = await request.request(endpoint, options);
      if (!this.active(isCurrent)) { throw new Error('MCP OAuth请求已取消'); }
      if (response.responseCode >= 300 && response.responseCode < 400) { throw new Error('MCP OAuth端点发生重定向，已停止以保护凭据'); }
      const result = new McpOAuthJSON(); result.code = response.responseCode;
      const raw = typeof response.result === 'string' ? response.result : '';
      if (raw.length > 256 * 1024) { throw new Error('MCP OAuth元数据或响应过大'); }
      if (result.code >= 200 && result.code < 300) {
        const value = JSON.parse(raw) as Record<string, Object>;
        if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('MCP OAuth响应格式无效'); }
        result.value = value;
      }
      return result;
    } catch (error) {
      if (!this.active(isCurrent)) { throw new Error('MCP OAuth请求已取消'); }
      throw error as Error;
    } finally { clearInterval(timer); this.requests.delete(request); request.destroy(); }
  }
}
