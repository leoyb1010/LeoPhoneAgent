import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  migrateLegacyXdmakerDir,
  resetLegacyXdmakerMigrationCacheForTest,
} from '../utils/legacyXdmakerMigration';

describe('migrateLegacyXdmakerDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdmaker-migration-'));
    resetLegacyXdmakerMigrationCacheForTest();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content = 'x') {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  it('no-op 当 .xdmaker 不存在', async () => {
    await migrateLegacyXdmakerDir(root);
    expect(fs.existsSync(path.join(root, '.cindy'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
  });

  it('.cindy 不存在时整目录 rename', async () => {
    write('.xdmaker/automations/schedules.json', '{"version":1,"schedules":[]}');
    write('.xdmaker/project-knowledge/TOC.md', '# toc');

    await migrateLegacyXdmakerDir(root);

    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(
      fs.readFileSync(path.join(root, '.cindy', 'automations', 'schedules.json'), 'utf8'),
    ).toContain('"version"');
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      '# toc',
    );
  });

  it('.cindy 已存在时只搬缺失子项并删掉空壳', async () => {
    write('.xdmaker/automations/schedules.json', 'old-automations');
    write('.cindy/project-knowledge/TOC.md', 'new-toc');

    await migrateLegacyXdmakerDir(root);

    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.cindy', 'automations', 'schedules.json'), 'utf8')).toBe(
      'old-automations',
    );
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      'new-toc',
    );
  });

  it('同名文件冲突时保留旧目录、返回 incomplete、绝不覆盖 .cindy 侧', async () => {
    write('.xdmaker/automations/schedules.json', 'legacy');
    write('.cindy/automations/schedules.json', 'current');

    const result = await migrateLegacyXdmakerDir(root);

    expect(result).toEqual({ complete: false });
    expect(fs.readFileSync(path.join(root, '.cindy', 'automations', 'schedules.json'), 'utf8')).toBe(
      'current',
    );
    expect(
      fs.readFileSync(path.join(root, '.xdmaker', 'automations', 'schedules.json'), 'utf8'),
    ).toBe('legacy');
  });

  it('幂等：同一 root 重复调用不报错、结果不变', async () => {
    write('.xdmaker/project-knowledge/TOC.md', '# toc');

    await migrateLegacyXdmakerDir(root);
    await migrateLegacyXdmakerDir(root);
    resetLegacyXdmakerMigrationCacheForTest();
    await migrateLegacyXdmakerDir(root);

    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      '# toc',
    );
  });

  it('.xdmaker 是普通文件（非目录）时不动它', async () => {
    write('.xdmaker', 'not-a-dir');

    await migrateLegacyXdmakerDir(root);

    expect(fs.readFileSync(path.join(root, '.xdmaker'), 'utf8')).toBe('not-a-dir');
    expect(fs.existsSync(path.join(root, '.cindy'))).toBe(false);
  });

  it('rootDir 为空时静默返回 complete', async () => {
    await expect(migrateLegacyXdmakerDir('')).resolves.toEqual({ complete: true });
  });

  it('并发调用共享同一 Promise，迁移完成前不会提前返回', async () => {
    write('.xdmaker/project-knowledge/TOC.md', '# toc');

    const results = await Promise.all([
      migrateLegacyXdmakerDir(root),
      migrateLegacyXdmakerDir(root),
      migrateLegacyXdmakerDir(root),
    ]);

    expect(results).toEqual([{ complete: true }, { complete: true }, { complete: true }]);
    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      '# toc',
    );
  });

  it('同名子目录递归合并缺失项（空骨架不遮蔽旧数据）', async () => {
    write('.xdmaker/project-knowledge/manifest.yaml', 'modules: []');
    write('.xdmaker/project-knowledge/modules/foo.md', '# foo');
    // .cindy/project-knowledge exists but is empty (simulates failed prior init)
    fs.mkdirSync(path.join(root, '.cindy', 'project-knowledge'), { recursive: true });

    await migrateLegacyXdmakerDir(root);

    expect(
      fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'manifest.yaml'), 'utf8'),
    ).toBe('modules: []');
    expect(
      fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'modules', 'foo.md'), 'utf8'),
    ).toBe('# foo');
    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
  });

  it('失败的迁移不被永久缓存，后续调用可重试', async () => {
    write('.xdmaker/project-knowledge/TOC.md', '# toc');
    // Block rename by placing a file (not dir) at .cindy — renameSync will fail
    // because .xdmaker is a dir and .cindy already exists as a file
    fs.writeFileSync(path.join(root, '.cindy'), 'blocker');

    await migrateLegacyXdmakerDir(root);
    // Should have failed (warn-only, not thrown)
    expect(fs.existsSync(path.join(root, '.xdmaker', 'project-knowledge', 'TOC.md'))).toBe(true);

    // Remove the blocker, retry — should succeed now because cache was cleared on failure
    fs.unlinkSync(path.join(root, '.cindy'));
    await migrateLegacyXdmakerDir(root);

    expect(fs.existsSync(path.join(root, '.xdmaker'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.cindy', 'project-knowledge', 'TOC.md'), 'utf8')).toBe(
      '# toc',
    );
  });
});
