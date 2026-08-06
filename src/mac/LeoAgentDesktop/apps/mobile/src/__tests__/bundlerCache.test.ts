// @ts-nocheck —— 被测对象是 .mjs 发布工具模块,vitest 跑其逻辑(用沙箱 tmp/mobileDir,不碰真实缓存)。
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearBundlerCache } from '../../scripts/lib/bundler-cache.mjs';

function sandbox(fn: (dirs: { tmp: string; mobileDir: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'xdt-bundler-cache-'));
  const tmp = join(root, 'tmp');
  const mobileDir = join(root, 'mobile');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(mobileDir, { recursive: true });
  try {
    fn({ tmp, mobileDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const mkdirp = (p: string) => { mkdirSync(p, { recursive: true }); writeFileSync(join(p, 'x'), '1'); };

describe('clearBundlerCache', () => {
  it('删 metro-cache / metro-cache-* / haste-map-* + node_modules/.cache + .expo,保留无关目录', () => {
    sandbox(({ tmp, mobileDir }) => {
      mkdirp(join(tmp, 'metro-cache'));
      mkdirp(join(tmp, 'metro-cache-abc123'));
      mkdirp(join(tmp, 'haste-map-xyz'));
      mkdirp(join(tmp, 'metro-someones-project'));  // 非缓存的 metro- 前缀目录,不应误删
      mkdirp(join(tmp, 'something-else'));           // 无关,应保留
      mkdirp(join(mobileDir, 'node_modules', '.cache'));
      mkdirp(join(mobileDir, '.expo'));

      const removed = clearBundlerCache({ mobileDir, tmp });

      expect(existsSync(join(tmp, 'metro-cache'))).toBe(false);
      expect(existsSync(join(tmp, 'metro-cache-abc123'))).toBe(false);
      expect(existsSync(join(tmp, 'haste-map-xyz'))).toBe(false);
      expect(existsSync(join(tmp, 'metro-someones-project'))).toBe(true); // 宽泛 metro-* 不再误删
      expect(existsSync(join(tmp, 'something-else'))).toBe(true);         // 无关目录未被误删
      expect(existsSync(join(mobileDir, 'node_modules', '.cache'))).toBe(false);
      expect(existsSync(join(mobileDir, '.expo'))).toBe(false);
      expect(removed.length).toBe(5);
    });
  });

  it('缓存不存在时幂等、不抛错、返回空', () => {
    sandbox(({ tmp, mobileDir }) => {
      expect(clearBundlerCache({ mobileDir, tmp })).toEqual([]);
    });
  });

  it('缺 mobileDir → 抛错', () => {
    expect(() => clearBundlerCache({ tmp: '/tmp' } as never)).toThrow(/mobileDir/);
  });
});
