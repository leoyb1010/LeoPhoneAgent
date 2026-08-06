import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'xdt-maker.mobile.home.view-preferences.v1';

/** 首页视图偏好:顶部设备筛选(null = 所有对话)与「按项目分组」开关,冷启动时恢复上次选择。 */
export interface HomeViewPreferences {
  groupByProject: boolean;
  /** 上次选中的电脑;name 用于设备列表尚未同步回来时的表头兜底显示。 */
  selectedDevice: { deviceId: string; name: string } | null;
}

export interface HomeViewPreferencePatch {
  groupByProject?: boolean;
  selectedDevice?: { deviceId: string; name: string } | null;
}

export async function readHomeViewPreferences(): Promise<HomeViewPreferences> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  if (!raw) return emptyPreferences();
  try {
    return normalizeStoredPreferences(JSON.parse(raw));
  } catch {
    return emptyPreferences();
  }
}

// save 是 read-modify-write:并发调用会拿到同一份旧快照互相覆盖(后落盘者丢掉先落盘的 patch),
// 用单一 pending 链把「读 → 合并 → 写」串行化,保证每次写都基于上一次写完后的状态。
let writeChain: Promise<void> = Promise.resolve();

export function saveHomeViewPreferences(patch: HomeViewPreferencePatch): Promise<void> {
  const next = writeChain.then(() => writeHomeViewPreferences(patch));
  // 链自身吞掉失败,避免一次异常让后续所有写入跟着 reject。
  writeChain = next.catch(() => undefined);
  return next;
}

async function writeHomeViewPreferences(patch: HomeViewPreferencePatch): Promise<void> {
  const current = await readHomeViewPreferences();
  const next: HomeViewPreferences = {
    groupByProject: patch.groupByProject ?? current.groupByProject,
    // null 是有效值(切回「所有对话」),用 undefined 判断字段是否出现在 patch 里。
    selectedDevice: patch.selectedDevice !== undefined
      ? normalizeDevice(patch.selectedDevice)
      : current.selectedDevice,
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(serializePreferences(next))).catch(() => undefined);
}

export async function clearHomeViewPreferences(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
}

function emptyPreferences(): HomeViewPreferences {
  return {
    groupByProject: true,
    selectedDevice: null,
  };
}

function normalizeStoredPreferences(value: unknown): HomeViewPreferences {
  const record = readRecord(value);
  if (!record) return emptyPreferences();
  const deviceId = readString(record.deviceId);
  const deviceName = readString(record.deviceName);
  return {
    groupByProject: typeof record.groupByProject === 'boolean'
      ? record.groupByProject
      : true,
    selectedDevice: deviceId
      ? { deviceId, name: deviceName || deviceId }
      : null,
  };
}

function normalizeDevice(device: { deviceId: string; name: string } | null): HomeViewPreferences['selectedDevice'] {
  if (!device) return null;
  const deviceId = device.deviceId.trim();
  if (!deviceId) return null;
  return {
    deviceId,
    name: device.name.trim() || deviceId,
  };
}

function serializePreferences(preferences: HomeViewPreferences): Record<string, unknown> {
  return {
    groupByProject: preferences.groupByProject,
    ...(preferences.selectedDevice
      ? {
          deviceId: preferences.selectedDevice.deviceId,
          deviceName: preferences.selectedDevice.name,
        }
      : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export const __testing = {
  storageKey: STORAGE_KEY,
};
