export function batteryState(monitor) {
  if (typeof monitor?.isOnBatteryPower !== 'function') return { on: false, can: false };
  return { on: Boolean(monitor.isOnBatteryPower()), can: true };
}
