// Shim: openclaw/plugin-sdk/browser-config.
// parseBrowserHttpUrl/redactCdpUrl are self-contained upstream helpers (ported
// to _local/browser-cdp). movePathToTrash comes from vendored fs-safe.
export { parseBrowserHttpUrl, redactCdpUrl } from './_local/browser-cdp.js';
export { movePathToTrash } from '../_generated/vendor/fs-safe/dist/advanced.js';
