/**
 * transcript-relocation.test.ts — 会话移动时的 CLI 转录迁移。
 * ------------------------------------------------------------------------------------
 * 背景:CLI 按「cwd 转码目录」存取转录,xdt-maker 改 workingDir 后不搬转录会导致
 * resume 报 "No conversation found with session ID"(2026-07 对话移动到项目实测事故)。
 * 覆盖:
 *   - 旧 cwd 转码目录直接命中 → 复制到新 cwd 转码目录(含带空格路径的转码正确性);
 *   - 直接命中失败 → 全目录扫描兜底仍能找到源;
 *   - 目标已存在:不旧于源 → 跳过;比源旧(往返移动的过期副本)→ 覆盖刷新(replaced);
 *   - 源缺失 → 记 missing 不中断其余 id;
 *   - id 去重、空集 no-op、超长新路径放弃(targetKeyInexact)。
 * 另覆盖 ensureClaudeTranscriptInWorkingDir(resume / fork 后的转录就位兜底,
 * 2026-07-05 实测事故:fork jsonl 落在已删除 worktree 的孤儿转码目录):
 *   - 目标已是全局最新(唯一副本 / 比他处 stray 新)→ in-place 不动文件;
 *   - 目标缺失或旧于他处副本(cwd 漂移)→ restored 复制/覆盖归位;
 *   - 全局找不到 → missing;workingDir 转码 key 超长 → target-key-inexact。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sanitizeClaudeProjectKey } from '../claude-projects-fs.js';
import {
  ensureClaudeTranscriptInWorkingDir,
  relocateClaudeSessionTranscripts,
} from '../transcript-relocation.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-transcript-reloc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const SESSION_A = '25aadd4d-7e47-4ae9-8f8d-235a4bc96ff0';
const SESSION_B = '30c3a249-55d7-4051-b02d-cf12dc6d4f82';

/** 在 projectsRoot 下按 cwd 转码目录放一份转录。 */
async function seedTranscript(projectsRoot: string, cwd: string, sdkSessionId: string, content = '{"type":"user"}\n'): Promise<string> {
  const dir = path.join(projectsRoot, sanitizeClaudeProjectKey(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sdkSessionId}.jsonl`);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

describe('relocateClaudeSessionTranscripts', () => {
  it('copies transcripts from the old cwd project dir to the new one (space-containing path)', async () => {
    const projectsRoot = await makeTempDir();
    // 真实事故形态:dialogue 临时目录(含空格的 Application Support)→ 项目目录。
    const oldCwd = '/Users/alice/Library/Application Support/xdt-maker/dialogues/2026-07-02/ef3b0a81';
    const newCwd = '/Users/alice/Code/Tools/xdt-maker';
    await seedTranscript(projectsRoot, oldCwd, SESSION_A, '{"payload":"a"}\n');
    await seedTranscript(projectsRoot, oldCwd, SESSION_B, '{"payload":"b"}\n');

    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: [SESSION_A, SESSION_B, SESSION_A],
      oldWorkingDir: oldCwd,
      newWorkingDir: newCwd,
      projectsRoot,
    });

    expect(result.copied.sort()).toEqual([SESSION_A, SESSION_B].sort());
    expect(result.skipped).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.targetKeyInexact).toBe(false);

    // 转码目录名与 CLI 真实行为一致(空格 / 斜杠全部转 '-')。
    const targetDir = path.join(projectsRoot, '-Users-alice-Code-Tools-xdt-maker');
    const copiedA = await fs.readFile(path.join(targetDir, `${SESSION_A}.jsonl`), 'utf8');
    expect(copiedA).toBe('{"payload":"a"}\n');
    // 源文件保留(复制非移动)。
    const oldDir = path.join(projectsRoot, sanitizeClaudeProjectKey(oldCwd));
    await expect(fs.stat(path.join(oldDir, `${SESSION_A}.jsonl`))).resolves.toBeTruthy();
  });

  it('falls back to scanning all project dirs when the old cwd dir misses the file', async () => {
    const projectsRoot = await makeTempDir();
    // 转录躺在与 oldWorkingDir 不匹配的历史目录里(例如更早一次移动只改了 DB)。
    await seedTranscript(projectsRoot, '/some/other/legacy/cwd', SESSION_A);

    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: [SESSION_A],
      oldWorkingDir: '/Users/alice/stale/dir',
      newWorkingDir: '/Users/alice/target/project',
      projectsRoot,
    });

    expect(result.copied).toEqual([SESSION_A]);
    const target = path.join(
      projectsRoot,
      sanitizeClaudeProjectKey('/Users/alice/target/project'),
      `${SESSION_A}.jsonl`,
    );
    await expect(fs.stat(target)).resolves.toBeTruthy();
  });

  it('scan fallback picks the newest copy when multiple project dirs hold the same transcript', async () => {
    const projectsRoot = await makeTempDir();
    // 多次移动后多个目录都留有副本(迁移是复制不删源):按目录枚举顺序取第一个
    // 会把过期副本复制到目标,必须按 mtime 取最新(PR #472 Greptile review)。
    // 目录名首字母刻意让过期副本排在枚举顺序前面。
    const staleFile = await seedTranscript(projectsRoot, '/aaa/first-home', SESSION_A, '{"payload":"stale"}\n');
    await seedTranscript(projectsRoot, '/zzz/second-home', SESSION_A, '{"payload":"newest"}\n');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(staleFile, past, past);

    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: [SESSION_A],
      oldWorkingDir: '/does/not/match/any/dir',
      newWorkingDir: '/Users/alice/target/project',
      projectsRoot,
    });

    expect(result.copied).toEqual([SESSION_A]);
    const copied = await fs.readFile(
      path.join(projectsRoot, sanitizeClaudeProjectKey('/Users/alice/target/project'), `${SESSION_A}.jsonl`),
      'utf8',
    );
    expect(copied).toBe('{"payload":"newest"}\n');
  });

  it('keeps the target untouched when it is not older than the source', async () => {
    const projectsRoot = await makeTempDir();
    const oldCwd = '/old/cwd';
    const newCwd = '/new/cwd';
    const sourceFile = await seedTranscript(projectsRoot, oldCwd, SESSION_A, '{"payload":"source"}\n');
    await seedTranscript(projectsRoot, newCwd, SESSION_A, '{"payload":"existing"}\n');
    // 目标显式比源新(目标目录里已经聊出了更新内容的场景)。
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(sourceFile, past, past);

    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: [SESSION_A],
      oldWorkingDir: oldCwd,
      newWorkingDir: newCwd,
      projectsRoot,
    });

    expect(result.copied).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.skipped).toEqual([SESSION_A]);
    const kept = await fs.readFile(
      path.join(projectsRoot, sanitizeClaudeProjectKey(newCwd), `${SESSION_A}.jsonl`),
      'utf8',
    );
    expect(kept).toBe('{"payload":"existing"}\n');
  });

  it('replaces a stale target copy when the source is newer (round-trip move)', async () => {
    const projectsRoot = await makeTempDir();
    // 往返场景:会话 A→B 移动后在 B 聊过(B 的转录更新),再 B→A 移回,
    // A 里躺着首次移动前的过期副本——必须被 B 的新版覆盖,否则丢中间轮次。
    const dirA = '/cwd/a';
    const dirB = '/cwd/b';
    const staleInA = await seedTranscript(projectsRoot, dirA, SESSION_A, '{"payload":"stale"}\n');
    await seedTranscript(projectsRoot, dirB, SESSION_A, '{"payload":"fresh-from-b"}\n');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(staleInA, past, past);

    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: [SESSION_A],
      oldWorkingDir: dirB,
      newWorkingDir: dirA,
      projectsRoot,
    });

    expect(result.replaced).toEqual([SESSION_A]);
    expect(result.copied).toEqual([]);
    const refreshed = await fs.readFile(
      path.join(projectsRoot, sanitizeClaudeProjectKey(dirA), `${SESSION_A}.jsonl`),
      'utf8',
    );
    expect(refreshed).toBe('{"payload":"fresh-from-b"}\n');
  });

  it('records missing ids without aborting the rest', async () => {
    const projectsRoot = await makeTempDir();
    const oldCwd = '/old/cwd';
    await seedTranscript(projectsRoot, oldCwd, SESSION_B);

    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: [SESSION_A, SESSION_B],
      oldWorkingDir: oldCwd,
      newWorkingDir: '/new/cwd',
      projectsRoot,
    });

    expect(result.missing).toEqual([SESSION_A]);
    expect(result.copied).toEqual([SESSION_B]);
  });

  it('is a no-op for an empty id set', async () => {
    const projectsRoot = await makeTempDir();
    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: ['', '  '],
      oldWorkingDir: '/old/cwd',
      newWorkingDir: '/new/cwd',
      projectsRoot,
    });
    expect(result).toEqual({ copied: [], replaced: [], skipped: [], missing: [], targetKeyInexact: false });
  });

  it('gives up when the new cwd project key exceeds the exact-key length', async () => {
    const projectsRoot = await makeTempDir();
    const oldCwd = '/old/cwd';
    await seedTranscript(projectsRoot, oldCwd, SESSION_A);
    // CLI 对超长 cwd 的转码 key 追加私有 hash,本侧复算不出 → 放弃并标记,绝不写错目录。
    const longCwd = `/very/long/${'x'.repeat(300)}`;

    const result = await relocateClaudeSessionTranscripts({
      sdkSessionIds: [SESSION_A],
      oldWorkingDir: oldCwd,
      newWorkingDir: longCwd,
      projectsRoot,
    });

    expect(result.targetKeyInexact).toBe(true);
    expect(result.copied).toEqual([]);
    // 未产生任何新目录写入。
    const entries = await fs.readdir(projectsRoot);
    expect(entries).toEqual([sanitizeClaudeProjectKey(oldCwd)]);
  });
});

describe('ensureClaudeTranscriptInWorkingDir', () => {
  const WORKING_DIR = '/Users/alice/Code/Tools/xdt-maker';

  it('returns in-place and leaves the file untouched when the transcript is already in the cwd dir', async () => {
    const projectsRoot = await makeTempDir();
    const file = await seedTranscript(projectsRoot, WORKING_DIR, SESSION_A, '{"payload":"here"}\n');
    const before = await fs.stat(file);

    const outcome = await ensureClaudeTranscriptInWorkingDir({
      sdkSessionId: SESSION_A,
      workingDir: WORKING_DIR,
      projectsRoot,
    });

    expect(outcome).toBe('in-place');
    const after = await fs.stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('restores a transcript stranded in another project dir (orphan worktree fork scenario)', async () => {
    const projectsRoot = await makeTempDir();
    // 实测事故形态:fork jsonl 落在已删除 worktree 的转码目录,workingDir 目录下没有。
    await seedTranscript(
      projectsRoot,
      '/Users/alice/Code/Tools/xdt-maker-mobile-message-render-perf',
      SESSION_A,
      '{"payload":"forked"}\n',
    );

    const outcome = await ensureClaudeTranscriptInWorkingDir({
      sdkSessionId: SESSION_A,
      workingDir: WORKING_DIR,
      projectsRoot,
    });

    expect(outcome).toBe('restored');
    const restored = await fs.readFile(
      path.join(projectsRoot, sanitizeClaudeProjectKey(WORKING_DIR), `${SESSION_A}.jsonl`),
      'utf8',
    );
    expect(restored).toBe('{"payload":"forked"}\n');
    // 源文件保留(复制非移动)。
    await expect(
      fs.stat(
        path.join(
          projectsRoot,
          sanitizeClaudeProjectKey('/Users/alice/Code/Tools/xdt-maker-mobile-message-render-perf'),
          `${SESSION_A}.jsonl`,
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it('refreshes a stale target copy when a newer copy exists in another project dir (cwd drift)', async () => {
    const projectsRoot = await makeTempDir();
    // cwd 漂移的另一半形态:目标目录里躺着旧副本,CLI 在别的 cwd 下继续写同一
    // sdk session——直查命中即返回会让 resume 读到过期内容(PR #624 Codex review)。
    const staleTarget = await seedTranscript(projectsRoot, WORKING_DIR, SESSION_A, '{"payload":"stale"}\n');
    await seedTranscript(projectsRoot, '/some/drifted/cwd', SESSION_A, '{"payload":"newest"}\n');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(staleTarget, past, past);

    const outcome = await ensureClaudeTranscriptInWorkingDir({
      sdkSessionId: SESSION_A,
      workingDir: WORKING_DIR,
      projectsRoot,
    });

    expect(outcome).toBe('restored');
    const refreshed = await fs.readFile(staleTarget, 'utf8');
    expect(refreshed).toBe('{"payload":"newest"}\n');
  });

  it('keeps the target when it is newer than a stray copy elsewhere', async () => {
    const projectsRoot = await makeTempDir();
    const strayFile = await seedTranscript(projectsRoot, '/some/drifted/cwd', SESSION_A, '{"payload":"old-stray"}\n');
    const target = await seedTranscript(projectsRoot, WORKING_DIR, SESSION_A, '{"payload":"current"}\n');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(strayFile, past, past);

    const outcome = await ensureClaudeTranscriptInWorkingDir({
      sdkSessionId: SESSION_A,
      workingDir: WORKING_DIR,
      projectsRoot,
    });

    expect(outcome).toBe('in-place');
    const kept = await fs.readFile(target, 'utf8');
    expect(kept).toBe('{"payload":"current"}\n');
  });

  it('returns missing when no project dir holds the transcript', async () => {
    const projectsRoot = await makeTempDir();

    const outcome = await ensureClaudeTranscriptInWorkingDir({
      sdkSessionId: SESSION_A,
      workingDir: WORKING_DIR,
      projectsRoot,
    });

    expect(outcome).toBe('missing');
  });

  it('returns target-key-inexact for an over-long workingDir without touching any files', async () => {
    const projectsRoot = await makeTempDir();
    await seedTranscript(projectsRoot, '/some/dir', SESSION_A);

    const outcome = await ensureClaudeTranscriptInWorkingDir({
      sdkSessionId: SESSION_A,
      workingDir: `/very/long/${'x'.repeat(300)}`,
      projectsRoot,
    });

    expect(outcome).toBe('target-key-inexact');
    const entries = await fs.readdir(projectsRoot);
    expect(entries).toEqual([sanitizeClaudeProjectKey('/some/dir')]);
  });
});
