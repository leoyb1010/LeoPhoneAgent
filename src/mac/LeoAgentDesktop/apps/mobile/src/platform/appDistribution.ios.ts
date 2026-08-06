import {
  getIosAppDistributionInfo,
  type IosAppDistributionInfo,
} from 'xdt-ios-app-distribution';

let distributionPromise: Promise<IosAppDistributionInfo> | null = null;

/** Reads and caches the signed StoreKit app transaction environment for this process. */
export function getAppDistributionInfo(): Promise<IosAppDistributionInfo> {
  distributionPromise ??= getIosAppDistributionInfo();
  return distributionPromise;
}

/** True when StoreKit identifies the installed iOS app as a TestFlight build. */
export async function isTestFlightBuild(): Promise<boolean> {
  // Keep the public boolean method backed by the same cached transaction read
  // as the detailed JS API, so startup and later diagnostics cannot disagree.
  if (distributionPromise) return (await distributionPromise).isTestFlight;
  distributionPromise = getIosAppDistributionInfo();
  return (await distributionPromise).isTestFlight;
}
