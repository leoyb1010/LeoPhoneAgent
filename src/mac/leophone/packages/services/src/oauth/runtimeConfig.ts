import type { OAuthProviderId } from "@zcode/shared";

/** Provider 运行时配置（仅 host process 可见） */
export interface OAuthProviderRuntimeConfig {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  appId: string;
  redirectUri: string;
  businessLoginUrl?: string;
  appSecret?: string;
}

/** OAuth 全局运行时配置 */
export interface OAuthRuntimeConfig {
  providers: OAuthProviderRuntimeConfig[];
}

/**
 * 从运行时环境变量生成 OAuth 配置。
 *
 * 注意：这里只能在 host process 使用，避免把敏感配置暴露给 renderer。
 */
export function createOAuthRuntimeConfig(_env: NodeJS.ProcessEnv = process.env): OAuthRuntimeConfig {
  // [leo] LeoPhoneAgent 不接入任何官方账号(Z.ai / BigModel)。没有 provider,就没有登录入口、
  // 没有 token 刷新、也不会去官方 userinfo 校验;旧缓存的官方会话在 restore 时会被直接清掉。
  return { providers: [] };
}
