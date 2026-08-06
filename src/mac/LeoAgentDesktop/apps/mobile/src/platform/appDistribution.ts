import type { IosAppDistributionInfo } from 'xdt-ios-app-distribution';

/** Non-iOS fallback used by Android, web, Expo Go tests, and Node unit tests. */
const UNKNOWN_INFO: IosAppDistributionInfo = {
  environment: 'unknown',
  isTestFlight: false,
  source: 'unavailable',
  verification: 'unavailable',
};

/** Returns the current installation channel when the platform can identify it. */
export async function getAppDistributionInfo(): Promise<IosAppDistributionInfo> {
  return { ...UNKNOWN_INFO };
}

/** TestFlight exists only on iOS; other platforms deterministically return false. */
export async function isTestFlightBuild(): Promise<boolean> {
  return false;
}
