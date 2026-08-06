/**
 * ghostLocalPathGrant 单测 —— 任意本地路径附件的两层策略分类:
 * workdir 内/外、非绝对路径、不存在、目录、非媒体扩展名。
 * 路径一律在 os.tmpdir() 下的临时目录(规则 23:凭证不入仓,测试不落工作区)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyLocalAttachmentPath } from '../ghostLocalPathGrant';

const MIME: Record<string, string> = { '.png': 'image/png', '.mp4': 'video/mp4' };
const deps = { mimeForExt: (ext: string) => MIME[ext] ?? null };

let root: string;
let workdir: string;
let outsideDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-local-grant-'));
  workdir = path.join(root, 'workdir');
  outsideDir = path.join(root, 'elsewhere');
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(dir: string, name: string, content = 'x'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('classifyLocalAttachmentPath', () => {
  it('workdir 内的媒体文件 → inside-workdir(带 mime/size/name)', () => {
    const p = touch(workdir, 'frame.png', 'png-bytes');
    const c = classifyLocalAttachmentPath(p, workdir, deps);
    expect(c).toMatchObject({
      kind: 'inside-workdir',
      mimeType: 'image/png',
      size: 9,
      name: 'frame.png',
    });
  });

  it('workdir 外的媒体文件 → outside-workdir', () => {
    const p = touch(outsideDir, 'clip.mp4');
    const c = classifyLocalAttachmentPath(p, workdir, deps);
    expect(c.kind).toBe('outside-workdir');
  });

  it('无 workdir 语境(null)→ 一律 outside-workdir', () => {
    const p = touch(workdir, 'frame.png');
    const c = classifyLocalAttachmentPath(p, null, deps);
    expect(c.kind).toBe('outside-workdir');
  });

  it('workdir 路径解析不了(远程/已删)→ 按 outside-workdir 处理', () => {
    const p = touch(outsideDir, 'frame.png');
    const c = classifyLocalAttachmentPath(p, path.join(root, 'gone-workdir'), deps);
    expect(c.kind).toBe('outside-workdir');
  });

  it('前缀相似但不在 workdir 内的路径不误判为 inside(workdir vs workdir-evil)', () => {
    const evil = path.join(root, 'workdir-evil');
    fs.mkdirSync(evil);
    const p = touch(evil, 'frame.png');
    const c = classifyLocalAttachmentPath(p, workdir, deps);
    expect(c.kind).toBe('outside-workdir');
  });

  it('非绝对路径 / 不存在 / 目录 / NUL 字节 → not-local', () => {
    expect(classifyLocalAttachmentPath('relative/frame.png', workdir, deps).kind).toBe('not-local');
    expect(classifyLocalAttachmentPath(path.join(workdir, 'missing.png'), workdir, deps).kind).toBe('not-local');
    expect(classifyLocalAttachmentPath(workdir, workdir, deps).kind).toBe('not-local');
    expect(classifyLocalAttachmentPath(`${workdir}\0.png`, workdir, deps).kind).toBe('not-local');
  });

  it('真实文件但扩展名不在媒体白名单 → unsupported-type', () => {
    const p = touch(workdir, 'notes.txt');
    const c = classifyLocalAttachmentPath(p, workdir, deps);
    expect(c).toMatchObject({ kind: 'unsupported-type', ext: '.txt', name: 'notes.txt' });
  });

  it('symlink 指向 workdir 外时按真身判定(平台支持才验)', () => {
    const target = touch(outsideDir, 'real.png');
    const link = path.join(workdir, 'link.png');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // Windows 无 symlink 权限时跳过(不降级断言)
    }
    const c = classifyLocalAttachmentPath(link, workdir, deps);
    expect(c.kind).toBe('outside-workdir');
  });
});
