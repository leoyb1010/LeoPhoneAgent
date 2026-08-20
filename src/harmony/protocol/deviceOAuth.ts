export type DeviceAuth = {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export function parseDeviceAuth(json: unknown): DeviceAuth | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null
  const obj = json as Record<string, unknown>
  const deviceCode = typeof obj.device_code === "string" ? obj.device_code : ""
  const userCode = typeof obj.user_code === "string" ? obj.user_code : ""
  const uri =
    (typeof obj.verification_uri_complete === "string" && obj.verification_uri_complete) ||
    (typeof obj.verification_uri === "string" && obj.verification_uri) ||
    (typeof obj.verification_url === "string" && obj.verification_url) ||
    ""
  if (!deviceCode || !userCode || !uri) return null
  return {
    deviceCode,
    userCode,
    verificationUri: uri,
    expiresIn: Number(obj.expires_in ?? 900) || 900,
    interval: Number(obj.interval ?? 5) || 5,
  }
}

export function classifyDevicePoll(json: unknown, httpOk: boolean): string {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return httpOk ? "fatal" : "fatal"
  }
  const obj = json as Record<string, unknown>
  if (httpOk && typeof obj.access_token === "string" && obj.access_token.length > 0) {
    return "ok"
  }
  const error = `${obj.error ?? ""}`.toLowerCase()
  if (error === "authorization_pending") return "pending"
  if (error === "slow_down") return "slow"
  if (error === "access_denied") return "denied"
  if (error === "expired_token") return "expired"
  return "fatal"
}

export function accessTokenFromJson(json: unknown): string {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return ""
  const obj = json as Record<string, unknown>
  return typeof obj.access_token === "string" ? obj.access_token : ""
}

export const KIMI_DEVICE_URL = "https://auth.kimi.com/api/oauth/device_authorization"
export const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token"
export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const XAI_DISCOVERY = "https://auth.x.ai/.well-known/openid-configuration"
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

export function httpsHost(url: string): string {
  const lower = url.trim().toLowerCase()
  if (!lower.startsWith("https://")) return ""
  const hostPort = url.trim().slice("https://".length).split("/")[0] ?? ""
  return hostPort.split(":")[0].toLowerCase()
}

export function hostEndsWith(host: string, suffix: string): boolean {
  const h = host.trim().toLowerCase()
  const s = suffix.trim().toLowerCase()
  return h === s || h.endsWith(`.${s}`)
}
