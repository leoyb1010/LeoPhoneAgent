export const IDLE_SECONDS = 300;

export function idleProbe(monitor, seconds = IDLE_SECONDS) {
  if (typeof monitor?.getSystemIdleState !== 'function') {
    return { state: 'unknown', can: false, idle: false };
  }
  const state = String(monitor.getSystemIdleState(seconds) || 'unknown');
  return { state, can: true, idle: state === 'idle' };
}

export function idleCameBack(prev, next) {
  return Boolean(prev?.idle) && next?.state === 'active';
}
