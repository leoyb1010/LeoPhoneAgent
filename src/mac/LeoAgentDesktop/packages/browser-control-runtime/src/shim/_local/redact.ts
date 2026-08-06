/**
 * Conservative secret redactor for the browser runtime shim.
 *
 * Upstream's `redactSensitiveText` is a 1158-line, config-driven engine wired
 * into the OpenClaw logging/config graph (54 config types). We don't vendor
 * that graph. This is a deliberately small, defensive replacement that masks
 * the highest-risk token shapes before text reaches logs/error messages. It is
 * NOT a security boundary on its own — it is best-effort log hygiene, matching
 * the upstream call sites' intent (errors.ts / diagnostics).
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>  /  "authorization": "Bearer ..."
  [/\b(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]'],
  // sk-... / api keys / long opaque tokens after key-ish labels
  [/\b((?:api[_-]?key|apikey|token|secret|password|passwd|pwd)["'\s:=]+)[^\s"',}]{6,}/gi, '$1[redacted]'],
  // userinfo in URLs: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[redacted]@'],
  // standalone sk-/ghp_/xoxb- style prefixed secrets
  [/\b(sk|ghp|gho|xoxb|xoxp|AKIA)[_-][A-Za-z0-9]{8,}/g, '[redacted]'],
  // Slack app-level token: xapp-<n>-<APP>-<NUM>-<hash> (dash-separated segments,
  // so the short leading "-<n>-" doesn't fit the generic prefix shape above)
  [/\bxapp-[0-9]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  // JWT (three base64url segments) — carried in Authorization headers / URLs
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]'],
  // Google API key (AIza…) + OAuth access token (ya29.…)
  [/\bAIza[0-9A-Za-z_-]{16,}/g, '[redacted]'],
  [/\bya29\.[0-9A-Za-z_-]{10,}/g, '[redacted]'],
];

/** Best-effort masking of common secret shapes in free text. */
export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Tool-payload redaction reuses the same conservative pass. */
export function redactToolPayloadText(text: string): string {
  return redactSensitiveText(text);
}
