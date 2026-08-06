import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_GLOBAL_RULES_MARKER_FILE_NAME,
  codexGlobalRulesPaths,
  prepareCodexGlobalRulesCopy,
} from '../maker-host/codex-global-rules';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-rules-'));
  tmpDirs.push(dir);
  return dir;
}

async function setupPaths() {
  const root = await makeTmpDir();
  const homeDir = path.join(root, 'home with spaces');
  const codexHome = path.join(root, 'xdt-codex-home');
  return { homeDir, ...codexGlobalRulesPaths(codexHome, homeDir) };
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeMarker(markerFile: string): Promise<void> {
  await fs.mkdir(path.dirname(markerFile), { recursive: true });
  await fs.writeFile(markerFile, '');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexGlobalRulesCopy', () => {
  it('case 1: noops when source, destination, and marker are all missing', async () => {
    const paths = await setupPaths();

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('missing');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(await exists(paths.managedRulesFile)).toBe(false);
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 2: removes an orphan marker when source and destination are missing', async () => {
    const paths = await setupPaths();
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('marker-removed');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await exists(paths.managedRulesFile)).toBe(false);
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 3: keeps an unmarked destination when source is missing', async () => {
    const paths = await setupPaths();
    await writeFile(paths.managedRulesFile, 'user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('user-kept');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 4: removes the managed destination and marker when source is missing', async () => {
    const paths = await setupPaths();
    await writeFile(paths.managedRulesFile, 'managed rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('removed');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await exists(paths.managedRulesFile)).toBe(false);
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 5: copies source to an empty custom CODEX_HOME and writes the marker', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'global user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('copied');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('global user rules');
    expect(await exists(paths.markerFile)).toBe(true);
    expect(path.basename(paths.markerFile)).toBe(CODEX_GLOBAL_RULES_MARKER_FILE_NAME);
  });

  it('case 6: clears an orphan marker before copying source rules', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'global user rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('copied');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('global user rules');
    expect(await exists(paths.markerFile)).toBe(true);
  });

  it('case 7: keeps an unmarked destination even when source exists', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'global user rules');
    await writeFile(paths.managedRulesFile, 'local user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('user-kept');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('local user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 8: keeps an unchanged managed destination', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'same rules');
    await writeFile(paths.managedRulesFile, 'same rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('kept');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('same rules');
    expect(await exists(paths.markerFile)).toBe(true);
  });

  it('case 9: updates a changed managed destination from source', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'new global rules');
    await writeFile(paths.managedRulesFile, 'old managed rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('updated');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('new global rules');
    expect(await exists(paths.markerFile)).toBe(true);
  });

  it('does not overwrite or delete an unmarked destination across source states', async () => {
    const paths = await setupPaths();
    await writeFile(paths.managedRulesFile, 'local user rules');

    await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });
    await writeFile(paths.sourceRulesFile, 'global user rules');
    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('user-kept');
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('local user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('warns without touching destination when source exists but is not a file', async () => {
    const paths = await setupPaths();
    await fs.mkdir(paths.sourceRulesFile, { recursive: true });
    await writeFile(paths.managedRulesFile, 'local user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('error');
    expect(result.changed).toBe(false);
    expect(result.warnings[0]).toContain('source is not a file');
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('local user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('warns without recursively deleting a managed destination directory', async () => {
    const paths = await setupPaths();
    await fs.mkdir(paths.managedRulesFile, { recursive: true });
    await writeFile(path.join(paths.managedRulesFile, 'keep.txt'), 'do not remove');
    await writeFile(paths.sourceRulesFile, 'global user rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('error');
    expect(result.changed).toBe(false);
    expect(result.warnings[0]).toContain('destination is not a file');
    await expect(fs.readFile(path.join(paths.managedRulesFile, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    expect(await exists(paths.markerFile)).toBe(true);
  });
});
