import { useEffect, useState } from 'react';

import { apiClient } from '../utils/apiClient';
import { startVisibleInterval } from '../utils/visibilityInterval';

export type DoctorCheck = {
  id: string;
  category: 'cli' | 'leoapi';
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
};

export type DoctorReport = {
  generatedAt: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
};

// Bare envelope: GET /api/leocodebox/doctor → { success, report } (not data-wrapped).
type DoctorResponse = { success: boolean; report?: DoctorReport };

const REFRESH_INTERVAL_MS = 900_000; // 15 min — readiness rarely changes mid-session.

/**
 * Read-only environment readiness for the status-bar health light. Lazily polled;
 * a failed poll keeps the last known report. Refreshes on tab focus, after a
 * Leoapi switch, and on an explicit 'leocodebox:doctor-refresh' event.
 */
export function useDoctorReport(): DoctorReport | null {
  const [report, setReport] = useState<DoctorReport | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await apiClient.get<DoctorResponse>('/api/leocodebox/doctor');
        if (cancelled || !res?.success || !res.report) return;
        setReport(res.report);
      } catch {
        // Informational; keep the last known state on a failed poll.
      }
    };

    void load();
    const stopVisibleInterval = startVisibleInterval(() => void load(), REFRESH_INTERVAL_MS);
    const onRefresh = () => void load();
    window.addEventListener('leocodebox:leoapi-switched', onRefresh);
    window.addEventListener('leocodebox:doctor-refresh', onRefresh);
    return () => {
      cancelled = true;
      stopVisibleInterval();
      window.removeEventListener('leocodebox:leoapi-switched', onRefresh);
      window.removeEventListener('leocodebox:doctor-refresh', onRefresh);
    };
  }, []);

  return report;
}
