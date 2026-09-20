const HOT = new Set(['serious', 'critical']);

export function thermalState(monitor) {
  if (typeof monitor?.getCurrentThermalState !== 'function') {
    return { state: 'unknown', can: false, hot: false };
  }
  const state = String(monitor.getCurrentThermalState() || 'unknown');
  return { state, can: true, hot: HOT.has(state) };
}
