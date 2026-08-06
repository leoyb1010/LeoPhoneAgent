import { getModelAccessCredentialsStore } from './credentialsStore.js';

/**
 * effectiveEndpoint.ts — 当前生效的 XD 网关推理入口(endpoint 与 key 同源不变量)。
 * ---------------------------------------------------------------------------
 * 2026-07-17 定案:网关 endpoint **只认 model-access server 随凭据成对下发的值**
 * (credentialsStore source='server' 时的 endpoint)。端点清单的 xdGatewayBaseUrl
 * 字段已随本定案退役——登录同步成功前 / 存量手填 key(无 server 标记)一律返回
 * 空串,表示「网关不可用」:此时也不存在配套的 server key,消费方(one-shot 候选、
 * usage、语音凭据同步等)对空串各自有跳过 / 报错分支。
 *
 * 所有「拿 XD key 打网关」的 main 消费方都应经此取 endpoint(直接或经
 * runtime-configs.claudeUpstreamEndpoint()),保证 key 与 endpoint 永远同租户。
 *
 * 纯内存读(store 有缓存),可安全出现在请求期热路径(规则 10)。
 */
export function effectiveXdGatewayBaseUrl(): string {
  return getModelAccessCredentialsStore().getServerEndpoint() ?? '';
}
