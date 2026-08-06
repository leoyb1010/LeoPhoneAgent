import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';

const STORAGE_KEY_PREFIX = 'xdt.mobileVoiceHistory.v1';
const STORAGE_INDEX_KEY = `${STORAGE_KEY_PREFIX}.hosts`;
export const MAX_MOBILE_VOICE_HISTORY_ENTRIES = 100;
export const MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS = 360;

type StoredMobileVoiceHistoryEntry = {
  id: string;
  text: string;
  createdAt: number;
};

export async function getMobileVoiceInputHistoryForHost(hostDeviceId: string): Promise<string[]> {
  return (await readMobileVoiceHistoryEntries(hostDeviceId)).map((entry) => entry.text);
}

export async function recordMobileVoiceInputHistoryForHost(
  hostDeviceId: string,
  text: string,
): Promise<string | null> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const normalizedText = normalizeHistoryText(text);
  if (!normalizedText) return null;
  const entries = await readMobileVoiceHistoryEntries(normalizedHost);
  await addHostToHistoryIndex(normalizedHost);
  const duplicate = entries.find((entry) => entry.text === normalizedText);
  if (duplicate) return duplicate.id;
  const createdAt = Date.now();
  const entry = {
    id: createMobileVoiceHistoryId(normalizedText, createdAt),
    text: normalizedText,
    createdAt,
  };
  await writeMobileVoiceHistoryEntries(normalizedHost, [
    entry,
    ...entries,
  ]);
  return entry.id;
}

export async function updateMobileVoiceInputHistoryEntryForHost(
  hostDeviceId: string,
  entryId: string,
  text: string,
): Promise<void> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  const normalizedId = entryId.trim();
  const normalizedText = normalizeHistoryText(text);
  if (!normalizedId || !normalizedText) return;
  const entries = await readMobileVoiceHistoryEntries(normalizedHost);
  const entry = entries.find((candidate) => candidate.id === normalizedId);
  if (!entry) return;
  await writeMobileVoiceHistoryEntries(normalizedHost, [
    {
      ...entry,
      text: normalizedText,
    },
    ...entries.filter((candidate) => candidate.id !== normalizedId),
  ]);
}

export async function clearAllMobileVoiceInputHistories(): Promise<void> {
  const hosts = await readHistoryHostIndex();
  await Promise.all(
    hosts.map((hostDeviceId) =>
      deleteSecureItem(storageKeyForHostDevice(hostDeviceId)).catch(() => undefined),
    ),
  );
  await deleteSecureItem(STORAGE_INDEX_KEY).catch(() => undefined);
}

async function readMobileVoiceHistoryEntries(hostDeviceId: string): Promise<StoredMobileVoiceHistoryEntry[]> {
  const raw = await getSecureItem(storageKeyForHostDevice(normalizeHostDeviceId(hostDeviceId))).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeHistoryEntries(parsed);
  } catch {
    return [];
  }
}

async function writeMobileVoiceHistoryEntries(
  hostDeviceId: string,
  entries: StoredMobileVoiceHistoryEntry[],
): Promise<void> {
  const normalizedHost = normalizeHostDeviceId(hostDeviceId);
  await setSecureItem(storageKeyForHostDevice(normalizedHost), JSON.stringify(normalizeHistoryEntries(entries)));
  await addHostToHistoryIndex(normalizedHost);
}

function normalizeHistoryEntries(input: unknown[]): StoredMobileVoiceHistoryEntry[] {
  const entries: StoredMobileVoiceHistoryEntry[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<StoredMobileVoiceHistoryEntry>;
    const text = normalizeHistoryText(record.text);
    if (!text || entries.some((entry) => entry.text === text)) continue;
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now();
    entries.push({
      id: typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : createMobileVoiceHistoryId(text, createdAt),
      text,
      createdAt,
    });
    if (entries.length >= MAX_MOBILE_VOICE_HISTORY_ENTRIES) break;
  }
  return entries;
}

function normalizeHistoryText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, MAX_MOBILE_VOICE_HISTORY_ITEM_CHARS).trim();
}

function normalizeHostDeviceId(hostDeviceId: string): string {
  const normalized = hostDeviceId.trim();
  if (!normalized) throw new Error('host device id is required');
  return normalized;
}

function storageKeyForHostDevice(hostDeviceId: string): string {
  const safePrefix = hostDeviceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'host';
  return `${STORAGE_KEY_PREFIX}.${safePrefix}.${fnv1a(hostDeviceId)}`;
}

function createMobileVoiceHistoryId(text: string, timestamp: number): string {
  return `voice-${timestamp.toString(36)}-${fnv1a(`${timestamp}:${text}`)}`;
}

async function addHostToHistoryIndex(hostDeviceId: string): Promise<void> {
  const hosts = await readHistoryHostIndex();
  if (hosts.includes(hostDeviceId)) return;
  await writeHistoryHostIndex([...hosts, hostDeviceId]);
}

/**
 * 供凭据存量清理复用:用过语音输入的 host 一定同步过穿透凭据,这个索引是
 * SecureStore 无法枚举键时的第二个 host 推导来源(见
 * mobileVoiceCredentialStore.clearAllMobileVoiceCredentials)。
 */
export async function listMobileVoiceHistoryHosts(): Promise<string[]> {
  return readHistoryHostIndex();
}

async function readHistoryHostIndex(): Promise<string[]> {
  const raw = await getSecureItem(STORAGE_INDEX_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const hosts: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const normalized = item.trim();
      if (normalized && !hosts.includes(normalized)) hosts.push(normalized);
    }
    return hosts;
  } catch {
    return [];
  }
}

async function writeHistoryHostIndex(hosts: string[]): Promise<void> {
  const normalizedHosts = hosts
    .map((host) => host.trim())
    .filter((host, index, list) => host && list.indexOf(host) === index);
  if (normalizedHosts.length === 0) {
    await deleteSecureItem(STORAGE_INDEX_KEY);
    return;
  }
  await setSecureItem(STORAGE_INDEX_KEY, JSON.stringify(normalizedHosts));
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const __testing = {
  normalizeHistoryEntries,
  readHistoryHostIndex,
  storageIndexKey: STORAGE_INDEX_KEY,
  storageKeyForHostDevice,
};
