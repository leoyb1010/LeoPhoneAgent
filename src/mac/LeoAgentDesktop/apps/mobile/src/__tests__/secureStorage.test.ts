import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'web' }));
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os; } } }));
vi.mock('expo-secure-store', () => secureStore);

describe('secureStorage', () => {
  const webItems = new Map<string, string>();

  beforeEach(() => {
    platform.os = 'web';
    secureStore.getItemAsync.mockReset();
    secureStore.setItemAsync.mockReset();
    secureStore.deleteItemAsync.mockReset();
    webItems.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => webItems.get(key) ?? null,
      setItem: (key: string, value: string) => webItems.set(key, value),
      removeItem: (key: string) => webItems.delete(key),
    });
  });

  it('uses web storage on web previews', async () => {
    const { deleteSecureItem, getSecureItem, setSecureItem } = await import('@/auth/secureStorage');

    await setSecureItem('k', 'v');
    await expect(getSecureItem('k')).resolves.toBe('v');
    await deleteSecureItem('k');
    await expect(getSecureItem('k')).resolves.toBeNull();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('uses SecureStore on native platforms', async () => {
    platform.os = 'ios';
    secureStore.getItemAsync.mockResolvedValue('native-value');
    const { deleteSecureItem, getSecureItem, setSecureItem } = await import('@/auth/secureStorage');

    await expect(getSecureItem('k')).resolves.toBe('native-value');
    await setSecureItem('k', 'v');
    await deleteSecureItem('k');

    expect(secureStore.setItemAsync).toHaveBeenCalledWith('k', 'v');
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('k');
  });
});
