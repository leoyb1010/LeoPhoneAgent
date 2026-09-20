export const BUSY_RATIO = 0.9;

export function loadState(avg, ncpu) {
  const load = Number(Array.isArray(avg) ? avg[0] : avg) || 0;
  const cpus = Number(ncpu) || 0;
  if (!cpus) return { load: 0, ncpu: 0, can: false, busy: false };
  return { load, ncpu: cpus, can: true, busy: load / cpus >= BUSY_RATIO };
}
