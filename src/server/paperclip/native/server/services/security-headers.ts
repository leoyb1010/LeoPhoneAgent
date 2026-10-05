import type { RequestHandler } from "express";

/**
 * 发行层 1.1.6：基础安全响应头。
 * - HSTS 只在请求经 HTTPS（req.secure，取决于 TRUST_PROXY）或公开地址为 https 时发送，避免把
 *   纯 HTTP 的本机/私网部署锁死在 HTTPS。180 天（15552000 秒），不含 includeSubDomains/preload，
 *   以免影响同域其他服务。
 * - X-Frame-Options 只在路由未自行设置时补 SAMEORIGIN；同源插件 iframe 不受影响。
 * - 不设置 Content-Security-Policy：未经逐页验收会破坏现有 UI（内联样式、插件 UI、Vite 产物）。
 * 路由之后设置的同名头（例如部分接口的 Referrer-Policy: no-referrer）会覆盖这里的默认值。
 */
export function nativeSecurityHeaders(options: { publicUrl?: string | null } = {}): RequestHandler {
  let httpsPublicUrl = false;
  try { httpsPublicUrl = Boolean(options.publicUrl) && new URL(options.publicUrl as string).protocol === "https:"; } catch { httpsPublicUrl = false; }
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    if (req.secure || httpsPublicUrl) res.setHeader("Strict-Transport-Security", "max-age=15552000");
    next();
  };
}
