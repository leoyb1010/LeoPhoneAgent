import { vibrator } from '@kit.SensorServiceKit';
/** The OS applies the touch-feedback switch to usage:'touch'. Never fall back to notification/alarm usage. */
export class Haptics {
  static light(): void {
    try {
      vibrator.startVibration({ type: 'time', duration: 12 }, { usage: 'touch' }).catch(() => {});
    } catch (_error) { /* Unsupported/disabled haptics must not interrupt the action. */ }
  }
}
