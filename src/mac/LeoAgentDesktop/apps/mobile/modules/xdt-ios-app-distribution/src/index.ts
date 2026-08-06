import { requireOptionalNativeModule } from 'expo-modules-core';

export type IosAppStoreEnvironment = 'production' | 'sandbox' | 'xcode' | 'unknown';
export type IosAppDistributionSource = 'storekit2' | 'receipt' | 'unavailable';
export type IosAppTransactionVerification = 'verified' | 'unverified' | 'unavailable';

/** StoreKit-backed iOS installation-channel information exposed to app JavaScript. */
export interface IosAppDistributionInfo {
  environment: IosAppStoreEnvironment;
  isTestFlight: boolean;
  source: IosAppDistributionSource;
  verification: IosAppTransactionVerification;
}

/** Native Expo module contract implemented by XdtIosAppDistributionModule. */
interface XdtIosAppDistributionNativeModule {
  getDistributionInfo(): Promise<IosAppDistributionInfo>;
}

const nativeModule = requireOptionalNativeModule<XdtIosAppDistributionNativeModule>(
  'XdtIosAppDistribution',
);

const UNKNOWN_INFO: IosAppDistributionInfo = {
  environment: 'unknown',
  isTestFlight: false,
  source: 'unavailable',
  verification: 'unavailable',
};

function isEnvironment(value: unknown): value is IosAppStoreEnvironment {
  return value === 'production' || value === 'sandbox' || value === 'xcode' || value === 'unknown';
}

function isSource(value: unknown): value is IosAppDistributionSource {
  return value === 'storekit2' || value === 'receipt' || value === 'unavailable';
}

function isVerification(value: unknown): value is IosAppTransactionVerification {
  return value === 'verified' || value === 'unverified' || value === 'unavailable';
}

/**
 * Returns StoreKit distribution information. Missing native code and malformed
 * responses degrade to `unknown`; callers never need to catch native failures.
 */
export async function getIosAppDistributionInfo(): Promise<IosAppDistributionInfo> {
  if (!nativeModule) return { ...UNKNOWN_INFO };
  try {
    const info = await nativeModule.getDistributionInfo();
    if (!isEnvironment(info?.environment) || !isSource(info?.source) || !isVerification(info?.verification)) {
      return { ...UNKNOWN_INFO };
    }
    return {
      environment: info.environment,
      // Require both signals to agree so an unexpected native payload cannot
      // turn a production App Store build into a TestFlight classification.
      isTestFlight: info.environment === 'sandbox' && info.isTestFlight === true,
      source: info.source,
      verification: info.verification,
    };
  } catch {
    return { ...UNKNOWN_INFO };
  }
}

/** True only when StoreKit (or its receipt fallback) identifies TestFlight. */
export async function isIosTestFlightBuild(): Promise<boolean> {
  return (await getIosAppDistributionInfo()).isTestFlight;
}
