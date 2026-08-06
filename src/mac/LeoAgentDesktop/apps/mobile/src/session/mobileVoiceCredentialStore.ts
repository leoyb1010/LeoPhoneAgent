import { deleteSecureItem, getSecureItem } from '@/auth/secureStorage';
import { listMobileVoiceHistoryHosts } from '@/session/mobileVoiceHistoryStore';
import type { MobileVoiceCredentialSyncResult } from '@cindy/maker-shared/device-link-contract';
import { redactMobileVoiceCredentialValue } from '@/session/mobileVoiceCredentialRedaction';

const STORAGE_KEY_PREFIX = 'xdt.mobileVoiceCredential.v1';
const STORAGE_INDEX_KEY = `${STORAGE_KEY_PREFIX}.hosts`;
const STORAGE_VERSION = 1;
/** 旧版「语音服务模式(cindy/byok)」存储键,功能已删除,仅存量清理用。 */
const LEGACY_SERVICE_MODE_STORAGE_KEY = 'xdt.mobileVoiceServiceMode.v1';
/** 旧版 BYOK LiteLLM key 存储键,功能已删除,仅存量清理用。 */
const LEGACY_LITELLM_SETTINGS_STORAGE_KEY = 'xdt.mobileVoiceLiteLlmSettings.v1';

/**
 * 手机语音输入的内部配置图形状。历史上它是桌面经 device-link 同步下来并落
 * secure storage 的凭据;穿透与 BYOK 删除后不再持久化任何推理 key,类型只作为
 * ASR/refiner provider 图的内存形状复用(见 mobileCindyVoiceSession)。
 */
export type StoredMobileVoiceCredential = MobileVoiceCredentialSyncResult & {
  hostDeviceId: string;
  storageVersion: typeof STORAGE_VERSION;
  syncedAt: string;
};

/**
 * 存量清理:删掉历史版本落在 secure storage 的桌面穿透凭据(逐 host 键 + 索引
 * 键)、服务模式开关和 BYOK LiteLLM key。登出与 App 启动(auth 初始化)各调一
 * 次,防止旧版本留下的桌面 key 继续躺在手机里。
 */
export async function clearAllMobileVoiceCredentials(): Promise<void> {
  // SecureStore 无法枚举键,只能从可推导的 host 集合尽力清理。旧版本在写入逐
  // host 凭据后、更新凭据索引前退出会留下孤立键,因此并集第二个来源——语音
  // 历史的 host 索引(用过语音输入的 host 一定同步过凭据)。两个索引都缺失的
  // 极端残余在 SecureStore API 限制下无法枚举,属已知边界。
  const [credentialHosts, historyHosts] = await Promise.all([
    readCredentialHostIndex(),
    listMobileVoiceHistoryHosts().catch(() => [] as string[]),
  ]);
  const hosts = [...new Set([...credentialHosts, ...historyHosts])];
  await Promise.all(
    hosts.map((hostDeviceId) =>
      deleteSecureItem(storageKeyForHostDevice(hostDeviceId)).catch(() => undefined),
    ),
  );
  await deleteSecureItem(STORAGE_INDEX_KEY).catch(() => undefined);
  await deleteSecureItem(LEGACY_SERVICE_MODE_STORAGE_KEY).catch(() => undefined);
  await deleteSecureItem(LEGACY_LITELLM_SETTINGS_STORAGE_KEY).catch(() => undefined);
}

export function redactMobileVoiceCredentialForLog<T extends { proxyApiKey?: unknown }>(
  credential: T,
): Omit<T, 'proxyApiKey'> & { proxyApiKey: string } {
  return redactMobileVoiceCredentialValue(credential);
}

/** 纯函数:校验 provider 图形状(托管路径构造后自检用,防手滑改坏常量图)。 */
export function assertMobileVoiceCredentialShape(credential: MobileVoiceCredentialSyncResult): void {
  if (!credential || typeof credential !== 'object') throw new Error('voice credential is required');
  if (credential.temporary !== true || credential.credentialVersion !== 1) {
    throw new Error('unsupported voice credential version');
  }
  if (!readNonEmptyString(credential.proxyBaseUrl)) throw new Error('voice credential missing proxyBaseUrl');
  if (!readNonEmptyString(credential.proxyApiKey)) throw new Error('voice credential missing proxyApiKey');
  if (!credential.asr || typeof credential.asr !== 'object') throw new Error('voice credential missing ASR config');
  if (!readNonEmptyString(credential.asr.provider) || !readNonEmptyString(credential.asr.model)) {
    throw new Error('voice credential missing ASR provider');
  }
  if (credential.asr.auth !== 'api-key' && credential.asr.auth !== 'codex') {
    throw new Error('voice credential ASR auth must be api-key or codex');
  }
  if (credential.asrProviderChain !== undefined) {
    if (!Array.isArray(credential.asrProviderChain)) {
      throw new Error('voice credential ASR provider chain must be an array');
    }
    for (const item of credential.asrProviderChain) {
      if (!item || typeof item !== 'object') throw new Error('voice credential ASR provider chain contains invalid config');
      if (!readNonEmptyString(item.provider) || !readNonEmptyString(item.model)) {
        throw new Error('voice credential ASR provider chain contains invalid provider');
      }
      if (item.auth !== 'api-key' && item.auth !== 'codex') {
        throw new Error('voice credential ASR provider chain auth must be api-key or codex');
      }
    }
  }
  if (!credential.refiner || typeof credential.refiner !== 'object') {
    throw new Error('voice credential missing refiner config');
  }
  if (!readNonEmptyString(credential.refiner.provider) || !readNonEmptyString(credential.refiner.model)) {
    throw new Error('voice credential missing refiner provider');
  }
  if (credential.refiner.auth !== 'api-key' && credential.refiner.auth !== 'codex') {
    throw new Error('voice credential refiner auth must be api-key or codex');
  }
  if (credential.refiner.transport !== 'litellm-chat-completions' && credential.refiner.transport !== 'codex-responses') {
    throw new Error('voice credential refiner transport is unsupported');
  }
  if (credential.refinerProviderChain !== undefined) {
    if (!Array.isArray(credential.refinerProviderChain)) {
      throw new Error('voice credential refiner provider chain must be an array');
    }
    for (const item of credential.refinerProviderChain) {
      if (!item || typeof item !== 'object') throw new Error('voice credential refiner provider chain contains invalid config');
      if (!readNonEmptyString(item.provider) || !readNonEmptyString(item.model)) {
        throw new Error('voice credential refiner provider chain contains invalid provider');
      }
      if (item.auth !== 'api-key' && item.auth !== 'codex') {
        throw new Error('voice credential refiner provider chain auth must be api-key or codex');
      }
      if (item.transport !== 'litellm-chat-completions' && item.transport !== 'codex-responses') {
        throw new Error('voice credential refiner provider chain transport is unsupported');
      }
    }
  }
  if (credential.settings !== undefined) {
    if (!credential.settings || typeof credential.settings !== 'object') {
      throw new Error('voice credential settings must be an object');
    }
    if (!readNonEmptyString(credential.settings.language)) {
      throw new Error('voice credential settings missing language');
    }
    if (typeof credential.settings.refinementEnabled !== 'boolean') {
      throw new Error('voice credential settings missing refinementEnabled');
    }
    if (typeof credential.settings.playInteractionSound !== 'boolean') {
      throw new Error('voice credential settings missing playInteractionSound');
    }
  }
}

function storageKeyForHostDevice(hostDeviceId: string): string {
  const safePrefix = hostDeviceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'host';
  return `${STORAGE_KEY_PREFIX}.${safePrefix}.${fnv1a(hostDeviceId)}`;
}

async function readCredentialHostIndex(): Promise<string[]> {
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

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const __testing = {
  readCredentialHostIndex,
  storageIndexKey: STORAGE_INDEX_KEY,
  storageKeyForHostDevice,
  legacyServiceModeStorageKey: LEGACY_SERVICE_MODE_STORAGE_KEY,
  legacyLiteLlmSettingsStorageKey: LEGACY_LITELLM_SETTINGS_STORAGE_KEY,
};
