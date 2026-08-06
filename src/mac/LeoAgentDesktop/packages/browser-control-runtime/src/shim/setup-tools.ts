/**
 * Shim: openclaw/plugin-sdk/setup-tools.
 * Only `formatDocsLink` is referenced (doc-link formatting in help text).
 * Passthrough is sufficient.
 */
export function formatDocsLink(pathOrUrl: string): string {
  return pathOrUrl;
}
