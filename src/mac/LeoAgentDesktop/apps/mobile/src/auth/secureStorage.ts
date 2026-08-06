import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const memoryStorage = new Map<string, string>();

export async function getSecureItem(key: string): Promise<string | null> {
  if (Platform.OS !== 'web') return SecureStore.getItemAsync(key);
  return getWebStorage()?.getItem(key) ?? memoryStorage.get(key) ?? null;
}

export async function setSecureItem(key: string, value: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await SecureStore.setItemAsync(key, value);
    return;
  }
  const storage = getWebStorage();
  if (storage) storage.setItem(key, value);
  else memoryStorage.set(key, value);
}

export async function deleteSecureItem(key: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await SecureStore.deleteItemAsync(key);
    return;
  }
  getWebStorage()?.removeItem(key);
  memoryStorage.delete(key);
}

function getWebStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}
