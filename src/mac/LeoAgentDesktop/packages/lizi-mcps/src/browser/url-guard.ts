/**
 * Shared URL scheme guard for browser actions. Lives in its own module so both
 * the MCP boundary (`tools.ts`) and the recipe executor (`recipe-runner.ts`) can
 * use it without a circular import (`tools.ts` already imports `runRecipe` from
 * `recipe-runner.ts`).
 */

/**
 * True for http(s) URLs only. Used to block `file://` / `chrome://` / `data:` on
 * actions that actually *navigate* (navigate / open). The *scheme* is the only
 * thing constrained — localhost / private-network HTTP hosts stay reachable by
 * design (internal tooling needs them; see browser.ts SSRF note).
 *
 * NOTE: this is for navigation targets. It must NOT be applied to `responseBody`,
 * whose argument is a request-URL *match pattern* (e.g. `api/quotes`, `*​/api/*`),
 * not a navigable URL — see the boundary guard in tools.ts.
 */
export function isHttpUrl(u: string): boolean {
  try {
    const proto = new URL(u).protocol;
    return proto === 'http:' || proto === 'https:';
  } catch {
    return false;
  }
}
