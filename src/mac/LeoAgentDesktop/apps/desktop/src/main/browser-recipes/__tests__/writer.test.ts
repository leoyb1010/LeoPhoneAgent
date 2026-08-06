import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// writer.ts imports `shell` from electron (for openUserRecipesDir) and the
// loader (which imports `app`); stub both so the module is importable in node.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/xdt-test-userdata' },
  shell: { openPath: async () => '' },
}));

const { writeUserRecipe, resetSiteRecipe } = await import('../writer.js');
const { buildUserRecipes } = await import('../loader.js');

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-recipes-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Read a site's L2 files back the way the loader would. */
async function readBack(site: string) {
  const recipeRaw = await fs.readFile(path.join(dir, site, 'recipe.json'), 'utf8').catch(() => null);
  const entries = recipeRaw ? { [`${site}/recipe.json`]: recipeRaw } : {};
  return buildUserRecipes(entries, {});
}

describe('writeUserRecipe / resetSiteRecipe', () => {
  it('writes a recipe that reads back as a valid L2 entry', async () => {
    const res = await writeUserRecipe(
      { site: 'x.com', recipe: { id: 'x-search', steps: [{ action: 'navigate', url: 'https://x.com/' }] } },
      dir,
    );
    expect(res.ok).toBe(true);
    const back = await readBack('x.com');
    expect(back.recipes.get('x-search')?.id).toBe('x-search');
    expect(back.diagnostics).toEqual([]);
  });

  it('overwrites the same site on re-save (no auto-rename — preserves by-id override)', async () => {
    await writeUserRecipe({ site: 'x.com', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://one/' }] } }, dir);
    await writeUserRecipe({ site: 'x.com', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://two/' }] } }, dir);
    const files = await fs.readdir(path.join(dir, 'x.com'));
    expect(files).toEqual(['recipe.json']); // single file, overwritten
    const back = await readBack('x.com');
    expect((back.recipes.get('r')?.steps[0] as { url: string }).url).toBe('https://two/');
  });

  it('rejects a path-unsafe site segment', async () => {
    const res = await writeUserRecipe(
      { site: '../evil', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } },
      dir,
    );
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/invalid site/);
  });

  it('rejects dots-only segments that pass the char allowlist (.,..,...)', async () => {
    // `.` / `..` / `...` all match `^[a-zA-Z0-9.-]+$` but `path.join` would use
    // them to escape the recipes dir — they must be rejected explicitly.
    for (const site of ['.', '..', '...']) {
      const res = await writeUserRecipe(
        { site, recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } },
        dir,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/invalid site/);
    }
  });

  it('rejects a leading-dash segment and an over-length segment', async () => {
    for (const site of ['-rf', '-flag.com', `${'a'.repeat(254)}.com`]) {
      const res = await writeUserRecipe(
        { site, recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } },
        dir,
      );
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/invalid site/);
    }
  });

  it('resetSiteRecipe deletes the site dir (restore default = fall back to L1)', async () => {
    await writeUserRecipe({ site: 'x.com', recipe: { id: 'r', steps: [{ action: 'navigate', url: 'https://x/' }] } }, dir);
    const reset = await resetSiteRecipe('x.com', dir);
    expect(reset.ok).toBe(true);
    await expect(fs.readdir(path.join(dir, 'x.com'))).rejects.toBeTruthy(); // gone
  });
});
