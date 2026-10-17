import type {
  ProviderEndpointRoutingDecision,
  ProviderEndpointRoutingPort,
} from "@zcode/contracts";

/**
 * 静态实现只提供 URL 决策；Host 清理、请求与响应透传由公共 fetch wrapper 负责。
 *
 * [leo] LeoPhoneAgent 永不把请求路由到官方网关（上游会把官方 Coding Plan 模型端点改写到
 * `{ZCODE_BASE_URL}/api/v1/ultra*`，用官方账号鉴权）。3.15.1 起改写逻辑从
 * `resolveOfficialCodingPlanGatewayUrl` 搬到这里的 endpoint-routing 端口，这里恒返回 `routed: false`，
 * 官方端点映射表整段删除；用户自己配置的模型端点照常直连。
 */
export function createStaticProviderEndpointRoutingPort(
  _endpointOrigin: string,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl): Promise<ProviderEndpointRoutingDecision> {
      return { routed: false, url: requestUrl };
    },
  };
}
