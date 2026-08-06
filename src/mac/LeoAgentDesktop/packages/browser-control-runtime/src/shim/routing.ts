/**
 * Shim: openclaw/plugin-sdk/routing.
 *
 * These classify a session key as acp / cron / subagent, used only by
 * session-tab-cleanup to exempt those session types from tab cleanup. The
 * browser runtime drives ordinary (non-acp/cron/subagent) sessions, so all
 * three return false — meaning normal tab-cleanup applies, which is the correct
 * default for our single-context runtime.
 */
export function isAcpSessionKey(_sessionKey: string | undefined | null): boolean {
  return false;
}
export function isCronSessionKey(_sessionKey: string | undefined | null): boolean {
  return false;
}
export function isSubagentSessionKey(_sessionKey: string | undefined | null): boolean {
  return false;
}
