/**
 * Static, advisory safety scan for text that gets loaded into an agent — skill
 * markdown, MCP config, AGENTS.md/CLAUDE.md. Enabling any of these hands untrusted
 * instructions to the CLIs; this flags the highest-signal risk patterns BEFORE the
 * toggle so a user can look before they leap ("确认式智能"). It never blocks or
 * mutates — it only reports. Kept deliberately tight to avoid crying wolf.
 */

export type SafetySeverity = 'high' | 'medium' | 'low';

export type SafetyFinding = {
  severity: SafetySeverity;
  category: string;
  rule: string;
  /** 1-based line number of the match. */
  line: number;
  snippet: string;
};

export type SafetyReport = {
  findings: SafetyFinding[];
  highestSeverity: SafetySeverity | null;
};

type Rule = {
  id: string;
  category: string;
  severity: SafetySeverity;
  regex: RegExp;
};

const RULES: Rule[] = [
  // --- Data exfiltration / remote code execution ---
  { id: 'pipe-to-shell', category: 'exfiltration', severity: 'high', regex: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i },
  { id: 'base64-to-shell', category: 'exfiltration', severity: 'high', regex: /\bbase64\s+(--decode|-d|-D)\b[^\n|]*\|\s*(ba|z)?sh\b/i },
  { id: 'eval-atob', category: 'exfiltration', severity: 'high', regex: /\beval\s*\(\s*(atob|Buffer\.from)\s*\(/i },
  { id: 'reverse-shell', category: 'exfiltration', severity: 'high', regex: /\/dev\/tcp\/\d|\bnc\b[^\n]*-e\b|bash\s+-i\s*>&?/i },
  { id: 'exfil-secret-to-url', category: 'exfiltration', severity: 'medium', regex: /\b(curl|wget|fetch|Invoke-WebRequest)\b[^\n]*\b(token|secret|password|api[_-]?key|credential|\$env|process\.env)\b/i },

  // --- Destructive commands ---
  { id: 'rm-rf-root-home', category: 'destructive', severity: 'high', regex: /\brm\s+-[rf]{1,2}\b[^\n]*\s(\/|~|\$HOME)/i },
  { id: 'fork-bomb', category: 'destructive', severity: 'high', regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: 'chmod-777', category: 'destructive', severity: 'low', regex: /\bchmod\s+(-R\s+)?0?777\b/i },

  // --- Hardcoded secrets ---
  { id: 'private-key-block', category: 'secret', severity: 'high', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'aws-access-key', category: 'secret', severity: 'high', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-key', category: 'secret', severity: 'medium', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'github-token', category: 'secret', severity: 'medium', regex: /\bgh[posru]_[A-Za-z0-9]{30,}\b/ },
  { id: 'slack-token', category: 'secret', severity: 'medium', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },

  // --- Prompt injection (tight phrasing to limit false positives) ---
  { id: 'ignore-previous', category: 'prompt-injection', severity: 'medium', regex: /\b(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules?|messages?)\b/i },
  { id: 'override-system-prompt', category: 'prompt-injection', severity: 'medium', regex: /\b(reveal|print|leak|exfiltrate)\s+(your\s+|the\s+)?(system\s+prompt|api[_-]?keys?|secrets?|credentials?)\b/i },
];

const SEVERITY_ORDER: Record<SafetySeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * Scan text and return the risk findings. `ignoreRules` silences specific rule
 * ids (the whitelist path for a user who has vetted a known-good pattern).
 */
export function scanContentSafety(
  content: string,
  options?: { ignoreRules?: readonly string[] },
): SafetyReport {
  const ignore = new Set(options?.ignoreRules ?? []);
  const findings: SafetyFinding[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    for (const rule of RULES) {
      if (ignore.has(rule.id)) continue;
      if (rule.regex.test(rawLine)) {
        findings.push({
          severity: rule.severity,
          category: rule.category,
          rule: rule.id,
          line: index + 1,
          snippet: rawLine.trim().slice(0, 160),
        });
      }
    }
  });

  const highestSeverity = findings.reduce<SafetySeverity | null>((highest, finding) => (
    !highest || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[highest] ? finding.severity : highest
  ), null);

  return { findings, highestSeverity };
}
