import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = process.cwd();
const packageJsonPath = path.join(desktopRoot, 'package.json');
const scriptPath = path.join(desktopRoot, 'scripts/skillhub-management-e2e.mjs');

describe('skillhub management E2E script contract', () => {
  it('keeps the raw script available without exposing a package script alias', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts).not.toHaveProperty('e2e:skillhub-management');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('covers the management states and saves screenshot evidence', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('seedModerationFixtures');
    expect(source).toContain('机审中');
    expect(source).toContain('人工复核中');
    expect(source).toContain('审核未通过');
    expect(source).toContain('Page.captureScreenshot');
    expect(source).toContain('Input.dispatchMouseEvent');
    expect(source).toContain("visibility: 'public'");
    expect(source).toContain('market-management-status-tags');
    expect(source).toContain('menu-no-team-transfer');
    expect(source).toContain('edit-market-info');
    expect(source).toContain('edit-market-info-saved-readback');
    expect(source).toContain('owner-detail-outside-mine-clone');
    expect(source).toContain('non-owner-detail-clone');
    expect(source).toContain('action-publish-result');
    expect(source).toContain('action-delete-result');
    expect(source).toContain('action-delist-result');
    expect(source).toContain('action-reclaim-result');
    // 新交互:点卡片本体进详情浮窗;上下架/收回并入管理可见性弹窗
    expect(source).toContain('clickCardTitle');
    expect(source).toContain('waitForPanel');
    expect(source).toContain('manage-visibility-dialog');
    expect(source).toContain('assertMenuItemDisabled');
    expect(source).toContain('team-owner-to-personal-needs-audience');
  });

  it('cleans old E2E fixtures before seeding repeatable management states', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain('ALL_FIXTURE_SLUGS');
    expect(source).toContain('DELETE FROM skills WHERE slug IN');
  });
});
