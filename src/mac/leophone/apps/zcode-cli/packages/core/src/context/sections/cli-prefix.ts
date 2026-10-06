// ============================================================
// CLI Prefix Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

// [leo] 产品身份是 LeoPhoneAgent;这一行之外的系统提示词与上游一致。
const CLI_PREFIX_PROMPT = "You are LeoPhoneAgent, an interactive coding agent";

export function buildCliPrefixSection(): ContextSection {
  const content = CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
