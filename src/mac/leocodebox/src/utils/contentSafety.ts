// Frontend mirror of server/shared/content-safety-scan.ts types (the client can't
// import server code). Used to pre-flight skill/MCP content before enabling it.

export type SafetySeverity = 'high' | 'medium' | 'low';

export type SafetyFinding = {
  severity: SafetySeverity;
  category: string;
  rule: string;
  line: number;
  snippet: string;
};

export type SafetyReport = {
  findings: SafetyFinding[];
  highestSeverity: SafetySeverity | null;
};

type ScanResponse = { success: boolean; data?: { report?: SafetyReport } };

/**
 * Advisory pre-flight scan via POST /api/providers/content-safety/scan
 * (createApiSuccessResponse envelope → read data.report). Returns null if the
 * scan itself couldn't run, so callers can degrade to "allow" rather than block.
 */
export async function scanContent(content: string, ignoreRules?: string[]): Promise<SafetyReport | null> {
  try {
    const { apiClient } = await import('./apiClient');
    const res = await apiClient.post<ScanResponse>('/api/providers/content-safety/scan', { content, ignoreRules });
    return res?.success && res.data?.report ? res.data.report : null;
  } catch {
    return null;
  }
}

export type SafetyGate = { tone: 'high' | 'medium' | 'clean'; blocking: boolean; count: number };

/**
 * Pure: map a scan report to a UI gate. High severity blocks (red, needs a second
 * confirm); medium/low warn but allow (yellow); nothing found is clean (green).
 */
export function resolveSafetyGate(report: SafetyReport | null): SafetyGate {
  const count = report?.findings.length ?? 0;
  if (!report || count === 0) return { tone: 'clean', blocking: false, count: 0 };
  if (report.highestSeverity === 'high') return { tone: 'high', blocking: true, count };
  return { tone: 'medium', blocking: false, count };
}
