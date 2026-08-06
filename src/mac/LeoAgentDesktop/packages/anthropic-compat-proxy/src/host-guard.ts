/**
 * 监听 host 安全校验 —— 纯函数,便于单测,由 CLI 入口(bin/proxy.ts)在 listen 前 gate。
 *
 * 背景:本代理会把客户端请求的 `authorization` / `x-api-key` 逐字节透传给上游
 * (见 server.ts forward()),所以它是一个"携带凭证的转发端点"。默认只绑 loopback
 * (127.0.0.1),仅本机可达是安全的;一旦被误配 / 诱导成 `0.0.0.0` 或任意网卡地址,
 * 就等于把这个转发凭证的端点暴露到网络上(尤其远端 SSH 主机 / 多租户机器场景),
 * 任何能访问该网卡的人都能借它带着受害者的凭证打上游 —— 属凭证泄露风险。
 *
 * 因此策略是 fail-closed:非 loopback 一律拒绝启动,除非显式设置逃生阀
 * `XDT_PROXY_ALLOW_NON_LOOPBACK=1`(此时放行但打警告)。
 */

/** 逃生阀环境变量名:显式设为 '1' 时才允许绑非 loopback 地址(带警告)。 */
export const ALLOW_NON_LOOPBACK_ENV = 'XDT_PROXY_ALLOW_NON_LOOPBACK';

/**
 * 判断监听 host 是否为 loopback(仅本机可达)。
 *
 * 严格白名单,只认 `127.0.0.1` / `::1` / `localhost`(大小写不敏感、忽略首尾空白)。
 * 故意不放宽到整个 `127.0.0.0/8` 段或 IPv4-mapped IPv6(如 `::ffff:127.0.0.1`):
 * 校验目标是"确认绑到本机回环",越窄越安全,宁可拒绝一个罕见的合法写法,也不放过
 * 一个看着像 loopback 实则不是的地址。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/** 校验结果:允许启动(可带警告)或拒绝启动(带错误说明)。 */
export type HostGuardResult =
  | { readonly ok: true; readonly host: string; readonly warning?: string }
  | { readonly ok: false; readonly host: string; readonly error: string };

/**
 * 决定给定 host 是否允许 listen —— 纯函数,不读 env / 不触碰 process,便于单测。
 *
 * @param requestedHost   解析出的 `--host` 值(已按上游默认补成 '127.0.0.1' 后传入)
 * @param allowNonLoopback 逃生阀是否开启(由调用方读 `XDT_PROXY_ALLOW_NON_LOOPBACK` 得出)
 */
export function resolveListenHost(
  requestedHost: string,
  allowNonLoopback: boolean,
): HostGuardResult {
  const normalizedHost = requestedHost.trim();
  if (isLoopbackHost(normalizedHost)) {
    return { ok: true, host: normalizedHost };
  }
  if (allowNonLoopback) {
    return {
      ok: true,
      host: normalizedHost,
      warning:
        `--host '${normalizedHost}' 不是 loopback 地址;因 ${ALLOW_NON_LOOPBACK_ENV}=1 放行。` +
        ` 该代理会把 authorization / x-api-key 逐字转发到上游,绑非 loopback 会把携带凭证的端点` +
        `暴露到网络,请确保这是在受信任网络里有意为之。`,
    };
  }
  return {
    ok: false,
    host: normalizedHost,
    error:
      `拒绝启动:--host '${normalizedHost}' 不是 loopback 地址。` +
      ` 该代理会把 authorization / x-api-key 逐字转发到上游,默认只允许绑 127.0.0.1 / ::1 / localhost,` +
      `否则会把携带凭证的转发端点暴露到网络(凭证泄露风险)。` +
      ` 如确需绑非 loopback(如受信任内网的 remote 场景),显式设置 ${ALLOW_NON_LOOPBACK_ENV}=1 后重试。`,
  };
}
