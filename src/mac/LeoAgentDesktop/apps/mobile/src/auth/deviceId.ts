import * as Crypto from 'expo-crypto';
import { getSecureItem, setSecureItem } from '@/auth/secureStorage';

const DEVICE_ID_KEY = 'xdt.mobile.deviceId';

export async function ensureDeviceId(): Promise<string> {
  const existing = await getSecureItem(DEVICE_ID_KEY).catch(() => null);
  if (existing) return existing;
  const next = createUuid();
  await setSecureItem(DEVICE_ID_KEY, next);
  return next;
}

function createUuid(): string {
  const cryptoWithUuid = Crypto as typeof Crypto & { randomUUID?: () => string };
  if (typeof cryptoWithUuid.randomUUID === 'function') return cryptoWithUuid.randomUUID();
  const bytes = Crypto.getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
