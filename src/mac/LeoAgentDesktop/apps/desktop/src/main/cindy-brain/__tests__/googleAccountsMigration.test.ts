/**
 * googleAccountsMigration 单测:老 Google 集成 → Filo Google 意识搬账
 * (只迁 filoCurrent、幂等、清单写败回退;规则 14 内存假体零 Electron)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FILO_CURRENT_PROFILE_ID,
  FILO_GOOGLE_GHOST_ID,
  FILO_GOOGLE_SECRET_KEY,
  migrateFiloGoogleAccounts,
  type GoogleAccountsMigrationDeps,
  type LegacyGoogleAccountRow,
} from '../googleAccountsMigration.js';

function memoryVault(seed?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    data,
    read: (g: string, k: string) => data.get(`${g} ${k}`) ?? null,
    store: (g: string, k: string, v: string) => {
      data.set(`${g} ${k}`, v);
      return true;
    },
    remove: (g: string, k: string) => {
      data.delete(`${g} ${k}`);
    },
  };
}

const CURRENT = (id: string, email: string | null): LegacyGoogleAccountRow => ({
  id,
  email,
  credentialProfileId: FILO_CURRENT_PROFILE_ID,
  updatedAt: 100,
});

function deps(over: Partial<GoogleAccountsMigrationDeps>): GoogleAccountsMigrationDeps {
  return {
    readLegacyManifest: () => ({ accounts: [CURRENT('acc-1', 'a@b.com')] }),
    readLegacyRefreshToken: () => 'rt-legacy',
    vault: memoryVault(),
    ...over,
  };
}

const RT_KEY = (id: string) => `${FILO_GOOGLE_SECRET_KEY}-rt-${id}`;
const ACCOUNTS_KEY = `${FILO_GOOGLE_SECRET_KEY}-accounts`;

describe('migrateFiloGoogleAccounts', () => {
  it('happy:filoCurrent 账号迁入,rt 落库 + 清单成形 + 默认账号', () => {
    const vault = memoryVault();
    const n = migrateFiloGoogleAccounts(deps({ vault }));
    expect(n).toBe(1);
    expect(vault.read(FILO_GOOGLE_GHOST_ID, RT_KEY('acc-1'))).toBe('rt-legacy');
    const manifest = JSON.parse(vault.read(FILO_GOOGLE_GHOST_ID, ACCOUNTS_KEY) ?? '{}');
    expect(manifest.defaultAccountId).toBe('acc-1');
    expect(manifest.accounts[0]).toMatchObject({ id: 'acc-1', label: 'a@b.com', status: 'connected' });
  });

  it('legacy 档案账号不迁(原本的就算了)', () => {
    const vault = memoryVault();
    const n = migrateFiloGoogleAccounts(
      deps({
        vault,
        readLegacyManifest: () => ({
          accounts: [{ id: 'old-1', email: 'x@y.com', credentialProfileId: 'filoLegacy', updatedAt: 1 }],
        }),
      }),
    );
    expect(n).toBe(0);
    expect(vault.read(FILO_GOOGLE_GHOST_ID, ACCOUNTS_KEY)).toBeNull();
  });

  it('幂等:意识侧已有账号清单 → 整体跳过,不读老存储', () => {
    const vault = memoryVault({ [`${FILO_GOOGLE_GHOST_ID} ${ACCOUNTS_KEY}`]: '{"defaultAccountId":"x","accounts":[]}' });
    const readLegacyManifest = vi.fn(() => ({ accounts: [CURRENT('acc-1', 'a@b.com')] }));
    const n = migrateFiloGoogleAccounts(deps({ vault, readLegacyManifest }));
    expect(n).toBe(0);
    expect(readLegacyManifest).not.toHaveBeenCalled();
  });

  it('老存储缺失 / 无 filoCurrent 账号 → 0,不建清单', () => {
    expect(migrateFiloGoogleAccounts(deps({ readLegacyManifest: () => null }))).toBe(0);
    expect(
      migrateFiloGoogleAccounts(deps({ readLegacyManifest: () => ({ accounts: [] }) })),
    ).toBe(0);
  });

  it('refresh token 读不到的账号跳过,只迁能迁的', () => {
    const vault = memoryVault();
    const n = migrateFiloGoogleAccounts(
      deps({
        vault,
        readLegacyManifest: () => ({ accounts: [CURRENT('acc-1', 'a@b.com'), CURRENT('acc-2', 'c@d.com')] }),
        readLegacyRefreshToken: (id) => (id === 'acc-1' ? 'rt-1' : null),
      }),
    );
    expect(n).toBe(1);
    const manifest = JSON.parse(vault.read(FILO_GOOGLE_GHOST_ID, ACCOUNTS_KEY) ?? '{}');
    expect(manifest.accounts.map((a: { id: string }) => a.id)).toEqual(['acc-1']);
  });

  it('清单写失败 → 回收已搬 rt,保持"没迁过"状态', () => {
    const vault = memoryVault();
    // 清单键写入失败(rt 键正常):模拟 safeStorage 半可用。
    const store = vi.fn((g: string, k: string, v: string) => {
      if (k === ACCOUNTS_KEY) return false;
      vault.data.set(`${g} ${k}`, v);
      return true;
    });
    const failing = { ...vault, store };
    const n = migrateFiloGoogleAccounts(deps({ vault: failing }));
    expect(n).toBe(0);
    // 已搬的 rt 被回收,下次启动可干净重试。
    expect(vault.read(FILO_GOOGLE_GHOST_ID, RT_KEY('acc-1'))).toBeNull();
  });
});
