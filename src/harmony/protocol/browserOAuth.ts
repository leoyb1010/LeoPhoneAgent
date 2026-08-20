export function availableCredentials(type: string): string[] {
  if (type === "xAI" || type === "kimiCode") return ["oauth", "apiKey"]
  if (type === "openAI" || type === "anthropic" || type === "openRouter") return ["apiKey", "oauth"]
  return ["apiKey"]
}

export function oauthHint(type: string): string {
  if (type === "anthropic") return "用 Claude 账号登录"
  if (type === "openAI") return "用 OpenAI Codex 登录"
  if (type === "openRouter") return "用 OpenRouter 登录"
  if (type === "xAI") return "用 xAI 登录（要 SuperGrok 或 X Premium+）"
  if (type === "kimiCode") return "用 Kimi Coding Plan 登录"
  return ""
}

export function apiKeyHint(type: string): string {
  if (type === "openAI") return "官方 API 和兼容第三方根"
  if (type === "anthropic") return "Anthropic 控制台的 API Key"
  if (type === "gemini") return "Google Gemini 的 API Key"
  if (type === "openRouter") return "OpenRouter 控制台的 API Key"
  if (type === "xAI") return "xAI Console 的 API Key（api.x.ai）"
  if (type === "kimiCode") return "Moonshot 账号的 API Key"
  return "自己填钥匙"
}

export function oauthSignInLabel(type: string): string {
  if (type === "anthropic") return "用 Claude 登录"
  if (type === "openAI") return "用 OpenAI 登录"
  if (type === "openRouter") return "用 OpenRouter 登录"
  if (type === "xAI") return "用 xAI 登录"
  if (type === "kimiCode") return "用 Kimi Code 登录"
  return "OAuth 登录"
}

export function oauthCallbackPort(type: string): number {
  if (type === "openRouter") return 3000
  if (type === "anthropic") return 54545
  if (type === "openAI") return 1455
  return 0
}

export function oauthRedirectPath(type: string): string {
  return type === "openAI" ? "/auth/callback" : "/callback"
}

export function oauthRedirectUri(type: string): string {
  const port = oauthCallbackPort(type)
  if (port <= 0) return ""
  return `http://localhost:${port}${oauthRedirectPath(type)}`
}

export function isOAuthCallbackUrl(url: string, type: string): boolean {
  const port = oauthCallbackPort(type)
  if (port <= 0) return false
  const path = oauthRedirectPath(type).toLowerCase()
  const lower = url.trim().toLowerCase()
  const noHash = lower.split("#")[0] ?? ""
  if (noHash.indexOf(path) < 0) return false
  return noHash.indexOf(`localhost:${port}`) >= 0 || noHash.indexOf(`127.0.0.1:${port}`) >= 0
}

export function queryValue(url: string, key: string): string {
  const cut = url.indexOf("?")
  if (cut < 0) return ""
  const search = url.substring(cut + 1).split("#")[0] ?? ""
  const pairs = search.split("&")
  const prefix = `${key}=`
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].startsWith(prefix)) {
      try {
        return decodeURIComponent(pairs[i].substring(prefix.length).replace(/\+/g, " "))
      } catch {
        return pairs[i].substring(prefix.length)
      }
    }
  }
  return ""
}

export function codeFromCallback(url: string, expectedState: string): string {
  const err = queryValue(url, "error_description") || queryValue(url, "error")
  if (err) throw new Error(err)
  const state = queryValue(url, "state")
  if (expectedState.length > 0 && state !== expectedState) {
    throw new Error("OAuth state 对不上")
  }
  const code = queryValue(url, "code")
  if (code.length === 0) throw new Error("没有授权码")
  return code
}

export const OPENROUTER_AUTH = "https://openrouter.ai/auth"
export const OPENROUTER_KEYS = "https://openrouter.ai/api/v1/auth/keys"
export const ANTHROPIC_AUTH = "https://claude.ai/oauth/authorize"
export const ANTHROPIC_TOKEN = "https://console.anthropic.com/v1/oauth/token"
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference"
export const OPENAI_AUTH = "https://auth.openai.com/oauth/authorize"
export const OPENAI_TOKEN = "https://auth.openai.com/oauth/token"
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_SCOPES = "openid profile email offline_access"

export function buildOAuthAuthUrl(type: string, challenge: string, state: string): string {
  const redirect = encodeURIComponent(oauthRedirectUri(type))
  const encodedState = encodeURIComponent(state)
  const encodedChallenge = encodeURIComponent(challenge)
  if (type === "openRouter") {
    return `${OPENROUTER_AUTH}?callback_url=${redirect}&code_challenge=${encodedChallenge}&code_challenge_method=S256&state=${encodedState}`
  }
  if (type === "anthropic") {
    return `${ANTHROPIC_AUTH}?client_id=${encodeURIComponent(ANTHROPIC_CLIENT_ID)}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent(ANTHROPIC_SCOPES)}&state=${encodedState}&code_challenge=${encodedChallenge}&code_challenge_method=S256`
  }
  if (type === "openAI") {
    return `${OPENAI_AUTH}?client_id=${encodeURIComponent(OPENAI_CLIENT_ID)}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent(OPENAI_SCOPES)}&state=${encodedState}&code_challenge=${encodedChallenge}&code_challenge_method=S256&codex_cli_simplified_flow=true&originator=codex_cli_rs&id_token_add_organizations=true`
  }
  throw new Error("这一家没有浏览器 OAuth")
}

export function tokenFromExchangeJson(type: string, json: unknown): string {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return ""
  const obj = json as Record<string, unknown>
  if (type === "openRouter") {
    return typeof obj.key === "string" ? obj.key : ""
  }
  return typeof obj.access_token === "string" ? obj.access_token : ""
}

export function oauthNeedsProxy(type: string): boolean {
  return type === "openAI" || type === "anthropic" || type === "xAI" || type === "gemini"
}

export function oauthNetworkHint(type: string): string {
  if (type === "openAI") return "OpenAI 登录页在 auth.openai.com，大陆直连通常打不开，需要可访问境外的网络或代理。"
  if (type === "anthropic") return "Claude 登录页在 claude.ai，大陆直连通常打不开，需要可访问境外的网络或代理。"
  if (type === "xAI") return "xAI 登录页在 auth.x.ai，大陆直连通常打不开，需要可访问境外的网络或代理。"
  if (type === "gemini") return "Gemini 接口在 generativelanguage.googleapis.com，大陆直连通常不通。"
  if (type === "openRouter") return "OpenRouter 通常可直连。打不开时复制链接换网络再试。"
  if (type === "kimiCode") return "Kimi 登录一般可直连。按页上的设备码在网页确认即可。"
  return ""
}

export function oauthRefreshUrl(type: string, tokenUrl: string = ""): string {
  if (type === "openAI") return OPENAI_TOKEN
  if (type === "anthropic") return ANTHROPIC_TOKEN
  if (type === "kimiCode") return "https://auth.kimi.com/api/oauth/token"
  if (type === "xAI") return tokenUrl
  return ""
}

export function oauthRefreshClientId(type: string): string {
  if (type === "openAI") return OPENAI_CLIENT_ID
  if (type === "anthropic") return ANTHROPIC_CLIENT_ID
  if (type === "kimiCode") return "17e5f671-d194-4dfb-9706-5516cb48c098"
  if (type === "xAI") return "b1a00492-073a-47ea-816f-4c329264a828"
  return ""
}

export function oauthRefreshUsesForm(type: string): boolean {
  return type === "kimiCode" || type === "xAI"
}

export function canRefreshOAuth(type: string): boolean {
  return type === "openAI" || type === "anthropic" || type === "kimiCode" || type === "xAI"
}

export function oauthRegionBlocked(code: string, info: string): boolean {
  const blob = `${code} ${info}`.toLowerCase()
  return (
    blob.includes("403") ||
    blob.includes("unsupported_country") ||
    blob.includes("unsupported_region") ||
    blob.includes("request_forbidden")
  )
}

export function oauthWebErrorCopy(code: string, info: string, type: string = ""): string {
  if (oauthRegionBlocked(code, info) && (type === "openAI" || type === "anthropic" || type === "xAI" || type.length === 0)) {
    const who = type === "anthropic" ? "Claude" : type === "xAI" ? "xAI" : "OpenAI"
    return `${who} 判定当前地区不可用。大陆直连时登录页会白屏或甩一串英文 JSON。打开可访问境外的网络后再进本页，或复制链接换网络打开。授权成功后仍要回到本页才能收码。`
  }
  const detail = [code, info].filter((part) => part.trim().length > 0).join(" ")
  const head = detail.length > 0 ? `页面打不开：${detail}` : "页面打不开"
  return `${head}。检查网络或代理，也可复制链接用系统浏览器看。授权回调仍要回到本页才能收码。`
}
