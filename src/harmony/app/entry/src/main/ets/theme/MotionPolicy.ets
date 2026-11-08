import { accessibility } from '@kit.AccessibilityKit';

function animationPreferenceChanged(reduced: boolean): void {
  MotionPolicy.reduced = reduced;
  AppStorage.setOrCreate('motionReduced', reduced);
}

/** Motion follows the system preference and never delays an action. */
export class MotionPolicy {
  static reduced: boolean = false;
  private static listening: boolean = false;

  static start(): void {
    if (MotionPolicy.listening) return;
    try {
      animationPreferenceChanged(accessibility.isAnimationReduceEnabledSync());
      accessibility.onAnimationReduceStateChange(animationPreferenceChanged);
      MotionPolicy.listening = true;
    } catch (_error) {
      animationPreferenceChanged(true);
    }
  }

  static stop(): void {
    if (!MotionPolicy.listening) return;
    accessibility.offAnimationReduceStateChange(animationPreferenceChanged);
    MotionPolicy.listening = false;
  }

  static duration(milliseconds: number): number {
    return MotionPolicy.reduced ? 0 : milliseconds;
  }
}
