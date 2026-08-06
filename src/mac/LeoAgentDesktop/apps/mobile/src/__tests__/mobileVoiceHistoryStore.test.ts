import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureItems = vi.hoisted(() => new Map<string, string>());

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => secureItems.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    secureItems.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    secureItems.delete(key);
  }),
}));

describe('mobileVoiceHistoryStore', () => {
  beforeEach(() => {
    secureItems.clear();
  });

  it('records submitted mobile voice text newest-first per controlled host', async () => {
    const {
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    const firstId = await recordMobileVoiceInputHistoryForHost('host-a', ' first phrase ');
    const secondId = await recordMobileVoiceInputHistoryForHost('host-a', 'second\nphrase');
    const otherHostId = await recordMobileVoiceInputHistoryForHost('host-b', 'other host');

    expect(firstId).toMatch(/^voice-/);
    expect(secondId).toMatch(/^voice-/);
    expect(otherHostId).toMatch(/^voice-/);

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([
      'second phrase',
      'first phrase',
    ]);
    await expect(getMobileVoiceInputHistoryForHost('host-b')).resolves.toEqual(['other host']);
  });

  it('dedupes repeat text without moving it ahead of newer entries', async () => {
    const {
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    const firstId = await recordMobileVoiceInputHistoryForHost('host-a', 'first phrase');
    await recordMobileVoiceInputHistoryForHost('host-a', 'second phrase');
    const duplicateId = await recordMobileVoiceInputHistoryForHost('host-a', 'first phrase');

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([
      'second phrase',
      'first phrase',
    ]);
    expect(duplicateId).toBe(firstId);
  });

  it('updates the submitted raw ASR history entry with refined text like desktop voice input', async () => {
    const {
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
      updateMobileVoiceInputHistoryEntryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    const firstId = await recordMobileVoiceInputHistoryForHost('host-a', 'older phrase');
    const rawId = await recordMobileVoiceInputHistoryForHost('host-a', 'raw asr words');
    await updateMobileVoiceInputHistoryEntryForHost('host-a', rawId!, ' refined words ');

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([
      'refined words',
      'older phrase',
    ]);
    expect(firstId).not.toBe(rawId);
  });

  it('normalizes long entries and caps the retained history', async () => {
    const {
      MAX_MOBILE_VOICE_HISTORY_ENTRIES,
      MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS,
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    for (let index = 0; index < MAX_MOBILE_VOICE_HISTORY_ENTRIES + 5; index += 1) {
      await recordMobileVoiceInputHistoryForHost('host-a', `entry ${index}`);
    }
    await recordMobileVoiceInputHistoryForHost('host-a', ` ${'x'.repeat(MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS + 20)} `);

    const history = await getMobileVoiceInputHistoryForHost('host-a');
    expect(history).toHaveLength(MAX_MOBILE_VOICE_HISTORY_ENTRIES);
    expect(history[0]).toHaveLength(MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS);
    expect(history[1]).toBe(`entry ${MAX_MOBILE_VOICE_HISTORY_ENTRIES + 4}`);
    expect(history).not.toContain('entry 5');
  });

  it('clears all recorded host histories on logout', async () => {
    const {
      __testing,
      clearAllMobileVoiceInputHistories,
      getMobileVoiceInputHistoryForHost,
      recordMobileVoiceInputHistoryForHost,
    } = await import('@/session/mobileVoiceHistoryStore');

    await recordMobileVoiceInputHistoryForHost('host-a', 'first phrase');
    await recordMobileVoiceInputHistoryForHost('host-b', 'second phrase');
    await clearAllMobileVoiceInputHistories();

    await expect(getMobileVoiceInputHistoryForHost('host-a')).resolves.toEqual([]);
    await expect(getMobileVoiceInputHistoryForHost('host-b')).resolves.toEqual([]);
    expect(secureItems.has(__testing.storageIndexKey)).toBe(false);
  });
});
