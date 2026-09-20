export const LAST_RUN_FILE = 'last-run.json';

export function parseLastRun(raw) {
  if (!raw || typeof raw !== 'object') return { dirty: false };
  return { dirty: raw.dirty === true };
}

export function lastRunWasAbrupt(prev) {
  return Boolean(prev?.dirty);
}

export function dirtyLastRun() {
  return { dirty: true };
}

export function cleanLastRun() {
  return { dirty: false };
}
