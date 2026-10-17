import {
  ZAI_PROVIDER_ID,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZaiOAuthUrl,
  resolveZaiOAuthClientId,
} from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
  readBoolean,
  readEnv,
} from "./configUtils.js";

export const ZAI_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: ZAI_PROVIDER_ID,
  displayName: "Z.ai",
  enabled: true,
  order: 1,
  // ZAI 当前 OAuth 授权入口使用 /api/oauth 前缀，继续走 /auth/oauth 会打开旧入口。
  // [leo] 官方账号 OAuth 不接入（runtimeConfig 的 provider 列表为空）：地址指向本机死端口，不内置官方 client id。
  authorizeUrl: "http://127.0.0.1:9/api/oauth/authorize",
  tokenUrl: "http://127.0.0.1:9/api/v1/oauth/token",
  userinfoUrl: "http://127.0.0.1:9/api/oauth/userinfo",
  businessLoginUrl: "http://127.0.0.1:9/api/auth/z/login",
  appId: "",
  redirectUri: "zcode://oauth/callback",
};

export function createZaiProviderRuntimeConfig(env: NodeJS.ProcessEnv): OAuthProviderRuntimeConfig {
  return {
    ...ZAI_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "ZAI_OAUTH_ENABLED", ZAI_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "ZAI_OAUTH_AUTHORIZE_URL") ??
      buildRuntimeZaiOAuthUrl(env, "/api/oauth/authorize"),
    tokenUrl:
      readEnv(env, "ZAI_OAUTH_TOKEN_URL") ?? buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/token"),
    userinfoUrl: resolveZaiUserinfoUrl(env),
    businessLoginUrl:
      readEnv(env, "ZAI_BUSINESS_LOGIN_URL") ??
      buildRuntimeZaiBusinessUrl(env, "/api/auth/z/login"),
    appId:
      // client_id 是公开 OAuth app 标识，按环境覆盖，避免测试/生产 OAuth 应用混用。
      resolveZaiOAuthClientId(env),
    redirectUri: buildDesktopOAuthRedirectUriFromEnv(env),
  };
}

export function resolveZaiUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return (
    readEnv(env, "ZAI_OAUTH_USERINFO_URL") ?? buildRuntimeZaiOAuthUrl(env, "/api/oauth/userinfo")
  );
}
