import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const osMock = vi.hoisted(() => ({ homedir: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => osMock.homedir },
    homedir: () => osMock.homedir,
  };
});

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getLocalThemesDir,
  loadLocalThemesSync,
  resetLocalThemesMigrationForTest,
} from '../local-themes/loader';

const THEME_JSON = JSON.stringify({
  id: 'my-theme',
  name: 'My Theme',
  type: 'dark',
  colors: { '--surface': '#111111' },
});

describe('local themes legacy dir migration (~/.xdmaker/themes -> ~/.cindy/themes)', () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(tmpdir(), 'themes-home-')));
    osMock.homedir = home;
    resetLocalThemesMigrationForTest();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('老目录存在且新目录不存在时整体搬迁，主题可被加载', () => {
    const oldDir = path.join(home, '.xdmaker', 'themes');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'my-theme.json'), THEME_JSON, 'utf8');

    const result = loadLocalThemesSync();

    expect(result.success).toBe(true);
    expect(result.themes.map((t) => t.id)).toEqual(['my-theme-local']);
    expect(fs.existsSync(path.join(home, '.cindy', 'themes', 'my-theme.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.xdmaker'))).toBe(false);
  });

  it('新目录已存在时不动老目录', () => {
    const oldDir = path.join(home, '.xdmaker', 'themes');
    const newDir = path.join(home, '.cindy', 'themes');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'legacy.json'), THEME_JSON, 'utf8');

    const result = loadLocalThemesSync();

    expect(result.success).toBe(true);
    expect(result.themes).toEqual([]);
    expect(fs.existsSync(path.join(oldDir, 'legacy.json'))).toBe(true);
  });

  it('老目录不存在时正常初始化新目录', () => {
    const result = loadLocalThemesSync();

    expect(result.success).toBe(true);
    expect(result.themes).toEqual([]);
    expect(fs.existsSync(getLocalThemesDir())).toBe(true);
  });

  it('getLocalThemesDir 指向 ~/.cindy/themes', () => {
    expect(getLocalThemesDir()).toBe(path.join(home, '.cindy', 'themes'));
  });

  it('只读取 brand.icon / brand.logo', () => {
    const dir = path.join(home, '.cindy', 'themes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'brand.json'),
      JSON.stringify({
        id: 'brand',
        name: 'Brand',
        type: 'light',
        colors: {},
        brand: { icon: '/tmp/icon.png', logo: '/tmp/logo.png' },
      }),
      'utf8',
    );

    const result = loadLocalThemesSync();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.themes[0]).toMatchObject({
      id: 'brand-local',
      brand: { icon: '/tmp/icon.png', logo: '/tmp/logo.png' },
    });
  });

  it('为存在的品牌图片附加随文件变化的运行时版本号', () => {
    const dir = path.join(home, '.cindy', 'themes');
    const iconPath = path.join(home, 'icon.png');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(iconPath, 'first', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'brand.json'),
      JSON.stringify({
        id: 'brand',
        name: 'Brand',
        type: 'light',
        colors: {},
        brand: { icon: iconPath },
      }),
      'utf8',
    );

    const first = loadLocalThemesSync();
    expect(first.success).toBe(true);
    if (!first.success) return;
    const firstRevision = first.themes[0]?.brandRevisions?.icon;
    expect(firstRevision).toBeTruthy();

    fs.writeFileSync(iconPath, 'second-version', 'utf8');
    const second = loadLocalThemesSync();
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.themes[0]?.brandRevisions?.icon).toBeTruthy();
    expect(second.themes[0]?.brandRevisions?.icon).not.toBe(firstRevision);
  });
});
