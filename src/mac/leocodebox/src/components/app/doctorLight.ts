// Pure mapping from the Doctor summary to a status-bar health-light tone.
// Mirrors server DoctorReport.summary shape without importing server code.

export type DoctorTone = 'ok' | 'warn' | 'fail';

export type DoctorSummary = { ok: number; warn: number; fail: number };

/** Any fail → red; else any warn → amber; else green. */
export function resolveDoctorTone(summary: DoctorSummary | null | undefined): DoctorTone {
  if (!summary) return 'ok';
  if (summary.fail > 0) return 'fail';
  if (summary.warn > 0) return 'warn';
  return 'ok';
}
