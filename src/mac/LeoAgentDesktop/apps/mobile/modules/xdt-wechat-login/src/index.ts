import { requireNativeModule } from 'expo-modules-core';

export interface WechatAuthOptions {
  appId: string;
  universalLink?: string;
  scope?: string;
  state: string;
}

export interface WechatAuthCodeResult {
  code: string;
}

interface XdtWechatLoginModule {
  isWechatInstalled(): Promise<boolean>;
  requestWechatAuthCode(
    options: WechatAuthOptions,
  ): Promise<WechatAuthCodeResult>;
  cancelWechatAuthRequest(): Promise<void>;
}

const nativeModule =
  requireNativeModule<XdtWechatLoginModule>('XdtWechatLogin');

export function isWechatInstalled(): Promise<boolean> {
  return nativeModule.isWechatInstalled();
}

export function requestWechatAuthCode(
  options: WechatAuthOptions,
): Promise<WechatAuthCodeResult> {
  return nativeModule.requestWechatAuthCode(options);
}

/** Releases a native request whose JavaScript-side foreground timeout already fired. */
export function cancelWechatAuthRequest(): Promise<void> {
  return nativeModule.cancelWechatAuthRequest();
}
