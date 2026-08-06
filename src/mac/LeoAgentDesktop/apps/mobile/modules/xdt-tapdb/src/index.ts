import { requireOptionalNativeModule } from 'expo-modules-core';

export type TapdbRegion = 'cn' | 'global';

export interface TapdbInitOptions {
  clientId: string;
  clientToken: string;
  region?: TapdbRegion;
  channel?: string;
  properties?: Record<string, string | number | boolean>;
}

export interface XdtTapdbModule {
  initialize(options: TapdbInitOptions): Promise<void>;
  setUserId(userId: string): Promise<void>;
  clearUser(): Promise<void>;
}

const nativeModule = requireOptionalNativeModule<XdtTapdbModule>('XdtTapdb');

export function isTapdbNativeAvailable(): boolean {
  return nativeModule !== null;
}

export async function initializeTapdb(options: TapdbInitOptions): Promise<boolean> {
  if (!nativeModule) return false;
  await nativeModule.initialize(options);
  return true;
}

export async function setTapdbUserId(userId: string): Promise<void> {
  await nativeModule?.setUserId(userId);
}

export async function clearTapdbUser(): Promise<void> {
  await nativeModule?.clearUser();
}
