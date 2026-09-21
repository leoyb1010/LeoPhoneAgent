/**
 * [leo] LeoPhoneAgent 是完全独立的个人产品:进程里任何代码都不允许连到 ZCode / Z.ai / 智谱的服务器。
 *
 * 源头上已经把官方登录、分享、CDN、帮助配置、插件市场等调用去掉了;这里是最后一道闸,
 * 防止遗漏的路径或以后同步上游时带进来的新调用把请求发出去。做法是在 DNS 解析这一层拦截:
 * Node 里 fetch(undici)、http/https、ws、net 建连都要经过 dns.lookup,一处覆盖全部。
 * import 这个模块即生效,必须是进程入口的第一个 import。
 */
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const BLOCKED_HOST = /(^|\.)(z\.ai|bigmodel\.cn|zhipuai\.cn|zhipu\.ai|chatglm\.cn|zcode\.ai)\.?$/i;

export function isLeoBlockedHost(hostname: string | null | undefined): boolean {
  return BLOCKED_HOST.test(String(hostname ?? "").trim());
}

function blockedError(hostname: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `[leo] ${hostname} 属于官方服务,LeoPhoneAgent 不连接`,
  );
  error.code = "ENOTFOUND";
  return error;
}

type LookupFn = (...args: unknown[]) => unknown;
const guardFlag = Symbol.for("leo.networkGuard.installed");
const dnsState = dns as unknown as Record<PropertyKey, unknown>;

if (!dnsState[guardFlag]) {
  dnsState[guardFlag] = true;

  const originalLookup = dns.lookup as unknown as LookupFn;
  (dns as unknown as { lookup: LookupFn }).lookup = function leoGuardedLookup(
    this: unknown,
    ...args: unknown[]
  ) {
    const hostname = args[0] as string;
    if (isLeoBlockedHost(hostname)) {
      const callback = args.find((arg): arg is (error: Error) => void => typeof arg === "function");
      if (callback) process.nextTick(callback, blockedError(hostname));
      return {};
    }
    return originalLookup.apply(this, args);
  };

  const originalPromiseLookup = dns.promises.lookup as unknown as LookupFn;
  (dns.promises as unknown as { lookup: LookupFn }).lookup = function leoGuardedPromiseLookup(
    this: unknown,
    ...args: unknown[]
  ) {
    const hostname = args[0] as string;
    if (isLeoBlockedHost(hostname)) return Promise.reject(blockedError(hostname));
    return originalPromiseLookup.apply(this, args);
  };

  // 打包后各进程入口会先求值共享 chunk,再跑到这里;用 `import { lookup } from "node:dns"`
  // 拿到的是 ESM 绑定,同步一次让这些绑定也指向带拦截的版本。
  syncBuiltinESMExports();
}
