/**
 * 历史上这里还有 apiRequest(renderer → main `api:request` → 主 server 的通用
 * 代理),已随最后一个调用者(meService GET /api/me)在 2026-07 apiBaseUrl 清理中
 * 退役——renderer 对业务 server 零请求。ApiError 保留:本地 IPC 服务层
 * (sessionService / messageService 等)沿用它的 code/statusCode 错误形状。
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
