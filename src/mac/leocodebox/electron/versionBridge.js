// Compatibility bridge retained only for the historical 1.1.3 reset build.
// Current releases remain monotonically increasing and use normal semver.
export const VERSION_RESET_TARGET = '1.1.3';
export const LEGACY_UPDATE_BRIDGE_VERSION = '1.36.3';

export function getUpdateMetadataVersion(productVersion) {
  return productVersion === VERSION_RESET_TARGET ? LEGACY_UPDATE_BRIDGE_VERSION : productVersion;
}
