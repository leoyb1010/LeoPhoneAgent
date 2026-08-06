/**
 * Binary-safe image preview reader for git-review.
 *
 * Renderer never reads git or the filesystem directly; this module resolves
 * each old/new side according to the current review source and returns small,
 * guarded data URLs for raster image diffs.
 */

import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import { REVIEW_IMAGE_RASTER_MIME_BY_EXT } from '../../shared/reviewImageExts.js';
import { resolveBranchBaseCommitOid } from './branchReader.js';
import { repoRelativeFsPath, resolveRepoContainedRealPath } from './fsPathGuard.js';
import { isSafeGitDiffIndexOid, isSafeGitObjectOid, isSafeGitPath, normalizeGitDiffIndexOid } from './gitPath.js';
import { runGit, runGitBuffer } from './gitRunner.js';
import type {
  FileDiff,
  ReviewImagePreviewData,
  ReviewImagePreviewRequest,
  ReviewImagePreviewSide,
  ReviewScope,
} from './types.js';

export const IMAGE_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_PREVIEW_CACHE_MAX_ENTRIES = 32;
const IMAGE_PREVIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const RASTER_MIME_BY_EXT = REVIEW_IMAGE_RASTER_MIME_BY_EXT;

export interface ImagePreviewReaderDeps {
  runGit: typeof runGit;
  runGitBuffer: typeof runGitBuffer;
  lstat: (filePath: string) => Promise<Stats>;
  realpath: (filePath: string) => Promise<string>;
  stat: (filePath: string) => Promise<Stats>;
  readFile: (filePath: string) => Promise<Buffer>;
  cache: ImagePreviewDataUrlCache;
}

interface CommitIdentity {
  oid: string;
  firstParentOid: string | null;
}

interface BranchImageIdentity {
  baseRef: string;
  headOid: string;
  mergeBaseOid: string;
}

type ImageSideSpec =
  | { kind: 'oid'; path: string | null; oid: string | null }
  | { kind: 'worktree'; path: string | null };

interface CachedImageDataUrl {
  dataUrl: string;
  byteLength: number;
}

export class ImagePreviewDataUrlCache {
  private readonly entries = new Map<string, CachedImageDataUrl>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries = IMAGE_PREVIEW_CACHE_MAX_ENTRIES,
    private readonly maxBytes = IMAGE_PREVIEW_CACHE_MAX_BYTES,
  ) {}

  get(key: string): string | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.dataUrl;
  }

  set(key: string, dataUrl: string, byteLength: number): void {
    if (byteLength > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, { dataUrl, byteLength });
    this.totalBytes += byteLength;
    this.trim();
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, CachedImageDataUrl] | undefined;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].byteLength;
    }
  }
}

const defaultCache = new ImagePreviewDataUrlCache();

function defaultDeps(): ImagePreviewReaderDeps {
  return {
    runGit,
    runGitBuffer,
    lstat: fs.lstat,
    realpath: fs.realpath,
    stat: fs.stat,
    readFile: fs.readFile,
    cache: defaultCache,
  };
}

function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

function toFsPath(repoRoot: string, gitPath: string): string {
  return repoRelativeFsPath(repoRoot, gitPath);
}

function mimeForPath(gitPath: string | null | undefined): string | null {
  if (!gitPath) return null;
  return RASTER_MIME_BY_EXT.get(path.extname(gitPath).toLowerCase()) ?? null;
}

export function isPreviewableRasterPath(gitPath: string | null | undefined): boolean {
  // SVG is intentionally excluded: it is a text format and needs separate
  // sanitize/sandbox design before image-style previewing.
  return Boolean(mimeForPath(gitPath));
}

export function isPreviewableImageDiff(diff: Pick<FileDiff, 'kind' | 'path' | 'oldPath'>): boolean {
  return diff.kind !== 'text' && (isPreviewableRasterPath(diff.path) || isPreviewableRasterPath(diff.oldPath));
}

function dataUrlFromBuffer(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readCommitIdentity(repoRoot: string, oid: string, deps: ImagePreviewReaderDeps): Promise<CommitIdentity> {
  if (!isSafeGitObjectOid(oid)) throw new Error('invalid commit oid');
  const { stdout: normalized } = await deps.runGit(['rev-parse', '--verify', `${oid}^{commit}`], { cwd: repoRoot });
  const commitOid = normalized.trim();
  const { stdout } = await deps.runGit(['rev-list', '--parents', '-n', '1', commitOid], { cwd: repoRoot });
  const parts = stdout.trim().split(/\s+/).filter(Boolean);
  return {
    oid: commitOid,
    firstParentOid: parts[1] ?? null,
  };
}

async function readBranchImageIdentity(repoRoot: string, baseRef: string, deps: ImagePreviewReaderDeps): Promise<BranchImageIdentity> {
  const baseOid = await resolveBranchBaseCommitOid(repoRoot, baseRef, deps.runGit);
  const { stdout: headOut } = await deps.runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repoRoot });
  const headOid = headOut.trim();
  const { stdout: mergeBaseOut } = await deps.runGit(['merge-base', baseOid, headOid], { cwd: repoRoot });
  const mergeBaseOid = mergeBaseOut.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(headOid) || !/^[0-9a-f]{40,64}$/i.test(mergeBaseOid)) {
    throw new Error('invalid branch image comparison');
  }
  return { baseRef, headOid, mergeBaseOid };
}

async function readIndexOid(repoRoot: string, gitPath: string | null, deps: ImagePreviewReaderDeps): Promise<string | null> {
  if (!gitPath) return null;
  try {
    const { stdout } = await deps.runGit(['ls-files', '-s', '--', literalPathspec(gitPath)], { cwd: repoRoot });
    const first = stdout.split(/\r?\n/).find(Boolean);
    const oid = first?.trim().split(/\s+/)[1] ?? null;
    return isSafeGitObjectOid(oid) ? oid : null;
  } catch {
    return null;
  }
}

async function readTreeOid(repoRoot: string, treeish: string | null, gitPath: string | null, deps: ImagePreviewReaderDeps): Promise<string | null> {
  if (!treeish || !gitPath) return null;
  try {
    const { stdout } = await deps.runGit(['rev-parse', '--verify', `${treeish}:${gitPath}`], { cwd: repoRoot });
    const oid = stdout.trim().split(/\r?\n/).at(-1) ?? null;
    return isSafeGitObjectOid(oid) ? oid : null;
  } catch {
    return null;
  }
}

async function readBlobSize(repoRoot: string, oid: string, deps: ImagePreviewReaderDeps): Promise<number> {
  if (!isSafeGitDiffIndexOid(oid)) throw new Error(`invalid blob oid: ${oid}`);
  const { stdout } = await deps.runGit(['cat-file', '-s', '--end-of-options', oid], { cwd: repoRoot });
  const size = Number(stdout.trim());
  if (!Number.isFinite(size) || size < 0) throw new Error(`invalid blob size for ${oid}`);
  return size;
}

function tooLargeSide(oid: string | null, mime: string | null, size: number): ReviewImagePreviewSide {
  return {
    present: true,
    oid,
    mime,
    size,
    tooLarge: true,
    error: null,
  };
}

function missingSide(oid: string | null, mime: string | null, error: string): ReviewImagePreviewSide {
  return {
    present: false,
    oid,
    mime,
    size: null,
    error,
  };
}

async function readOidSide(
  repoRoot: string,
  oid: string | null,
  gitPath: string | null,
  deps: ImagePreviewReaderDeps,
): Promise<ReviewImagePreviewSide | null> {
  const mime = mimeForPath(gitPath);
  if (!mime) return null;
  if (!oid) return missingSide(null, mime, 'image blob is unavailable');
  try {
    const size = await readBlobSize(repoRoot, oid, deps);
    if (size > IMAGE_PREVIEW_MAX_BYTES) return tooLargeSide(oid, mime, size);
    const cacheKey = `oid:${oid}:${mime}`;
    const cached = deps.cache.get(cacheKey);
    if (cached) {
      return { present: true, oid, mime, size, dataUrl: cached, error: null };
    }
    const { stdout } = await deps.runGitBuffer(['cat-file', 'blob', '--end-of-options', oid], {
      cwd: repoRoot,
      maxStdoutBytes: IMAGE_PREVIEW_MAX_BYTES + 1,
    });
    if (stdout.length > IMAGE_PREVIEW_MAX_BYTES) return tooLargeSide(oid, mime, stdout.length);
    const dataUrl = dataUrlFromBuffer(mime, stdout);
    deps.cache.set(cacheKey, dataUrl, stdout.length);
    return { present: true, oid, mime, size, dataUrl, error: null };
  } catch (err) {
    return missingSide(oid, mime, errorMessage(err));
  }
}

function withSafeIndexOids(diff: FileDiff): FileDiff {
  const oldOid = normalizeGitDiffIndexOid(diff.index.oldOid);
  const newOid = normalizeGitDiffIndexOid(diff.index.newOid);
  if (oldOid === diff.index.oldOid && newOid === diff.index.newOid) return diff;
  return {
    ...diff,
    index: {
      oldOid,
      newOid,
    },
  };
}

async function readWorktreeSide(
  repoRoot: string,
  gitPath: string | null,
  deps: ImagePreviewReaderDeps,
): Promise<ReviewImagePreviewSide | null> {
  const mime = mimeForPath(gitPath);
  if (!mime || !gitPath) return null;
  try {
    const fsPath = toFsPath(repoRoot, gitPath);
    const linkStat = await deps.lstat(fsPath);
    if (linkStat.isSymbolicLink()) return missingSide(null, mime, 'image symlink preview is unavailable');
    const { targetReal } = await resolveRepoContainedRealPath(repoRoot, gitPath, { realpath: deps.realpath });
    const stat = await deps.stat(targetReal);
    if (!stat.isFile()) return missingSide(null, mime, 'image file is unavailable');
    if (stat.size > IMAGE_PREVIEW_MAX_BYTES) return tooLargeSide(null, mime, stat.size);
    // Worktree content has no stable object id yet. Use stat metadata as a
    // cheap short-lived cache key instead of running `git hash-object` on every
    // preview request.
    const cacheKey = `worktree:${repoRoot}:${gitPath}:${stat.size}:${stat.mtimeMs}`;
    const cached = deps.cache.get(cacheKey);
    if (cached) {
      return { present: true, oid: null, mime, size: stat.size, dataUrl: cached, error: null };
    }
    const bytes = await deps.readFile(targetReal);
    if (bytes.length > IMAGE_PREVIEW_MAX_BYTES) return tooLargeSide(null, mime, bytes.length);
    const dataUrl = dataUrlFromBuffer(mime, bytes);
    deps.cache.set(cacheKey, dataUrl, bytes.length);
    return { present: true, oid: null, mime, size: bytes.length, dataUrl, error: null };
  } catch (err) {
    return missingSide(null, mime, errorMessage(err));
  }
}

async function readSide(
  repoRoot: string,
  spec: ImageSideSpec | null,
  deps: ImagePreviewReaderDeps,
): Promise<ReviewImagePreviewSide | null> {
  if (!spec) return null;
  if (spec.kind === 'worktree') return readWorktreeSide(repoRoot, spec.path, deps);
  return readOidSide(repoRoot, spec.oid, spec.path, deps);
}

async function resolveUnstagedSides(
  repoRoot: string,
  diff: FileDiff,
  deps: ImagePreviewReaderDeps,
): Promise<{ old: ImageSideSpec | null; new: ImageSideSpec | null }> {
  const oldPath = diff.oldPath ?? diff.path;
  if (diff.status === 'untracked') {
    return { old: null, new: { kind: 'worktree', path: diff.path } };
  }
  if (diff.status === 'added') {
    return { old: null, new: { kind: 'worktree', path: diff.path } };
  }
  if (diff.status === 'deleted') {
    return {
      old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readIndexOid(repoRoot, oldPath, deps) },
      new: null,
    };
  }
  return {
    old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readIndexOid(repoRoot, oldPath, deps) },
    new: { kind: 'worktree', path: diff.path },
  };
}

async function resolveStagedSides(
  repoRoot: string,
  diff: FileDiff,
  deps: ImagePreviewReaderDeps,
): Promise<{ old: ImageSideSpec | null; new: ImageSideSpec | null }> {
  const oldPath = diff.oldPath ?? diff.path;
  if (diff.status === 'added' || diff.status === 'untracked') {
    return {
      old: null,
      new: { kind: 'oid', path: diff.path, oid: diff.index.newOid ?? await readIndexOid(repoRoot, diff.path, deps) },
    };
  }
  if (diff.status === 'deleted') {
    return {
      old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readTreeOid(repoRoot, 'HEAD', oldPath, deps) },
      new: null,
    };
  }
  return {
    old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readTreeOid(repoRoot, 'HEAD', oldPath, deps) },
    new: { kind: 'oid', path: diff.path, oid: diff.index.newOid ?? await readIndexOid(repoRoot, diff.path, deps) },
  };
}

async function resolveCommitSides(
  repoRoot: string,
  diff: FileDiff,
  commitOid: string,
  deps: ImagePreviewReaderDeps,
): Promise<{ old: ImageSideSpec | null; new: ImageSideSpec | null }> {
  const identity = await readCommitIdentity(repoRoot, commitOid, deps);
  const oldPath = diff.oldPath ?? diff.path;
  if (diff.status === 'added' || diff.status === 'untracked') {
    return {
      old: null,
      new: { kind: 'oid', path: diff.path, oid: diff.index.newOid ?? await readTreeOid(repoRoot, identity.oid, diff.path, deps) },
    };
  }
  if (diff.status === 'deleted') {
    return {
      old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readTreeOid(repoRoot, identity.firstParentOid, oldPath, deps) },
      new: null,
    };
  }
  return {
    old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readTreeOid(repoRoot, identity.firstParentOid, oldPath, deps) },
    new: { kind: 'oid', path: diff.path, oid: diff.index.newOid ?? await readTreeOid(repoRoot, identity.oid, diff.path, deps) },
  };
}

async function resolveBranchSides(
  repoRoot: string,
  diff: FileDiff,
  baseRef: string,
  deps: ImagePreviewReaderDeps,
): Promise<{ old: ImageSideSpec | null; new: ImageSideSpec | null }> {
  const identity = await readBranchImageIdentity(repoRoot, baseRef, deps);
  const oldPath = diff.oldPath ?? diff.path;
  if (diff.status === 'added' || diff.status === 'untracked') {
    return {
      old: null,
      new: { kind: 'oid', path: diff.path, oid: diff.index.newOid ?? await readTreeOid(repoRoot, identity.headOid, diff.path, deps) },
    };
  }
  if (diff.status === 'deleted') {
    return {
      old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readTreeOid(repoRoot, identity.mergeBaseOid, oldPath, deps) },
      new: null,
    };
  }
  return {
    old: { kind: 'oid', path: oldPath, oid: diff.index.oldOid ?? await readTreeOid(repoRoot, identity.mergeBaseOid, oldPath, deps) },
    new: { kind: 'oid', path: diff.path, oid: diff.index.newOid ?? await readTreeOid(repoRoot, identity.headOid, diff.path, deps) },
  };
}

async function resolveSides(
  repoRoot: string,
  request: ReviewImagePreviewRequest,
  deps: ImagePreviewReaderDeps,
): Promise<{ old: ImageSideSpec | null; new: ImageSideSpec | null }> {
  const { diff } = request;
  if (diff.source === 'unstaged') return resolveUnstagedSides(repoRoot, diff, deps);
  if (diff.source === 'staged') return resolveStagedSides(repoRoot, diff, deps);
  if (diff.source === 'branch') {
    if (!request.branchBaseRef) throw new Error('branchBaseRef is required for branch image preview');
    return resolveBranchSides(repoRoot, diff, request.branchBaseRef, deps);
  }
  if (!request.commitOid) throw new Error('commitOid is required for commit image preview');
  return resolveCommitSides(repoRoot, diff, request.commitOid, deps);
}

export async function readImagePreview(
  scope: ReviewScope,
  request: ReviewImagePreviewRequest,
  depsInput: Partial<ImagePreviewReaderDeps> = {},
): Promise<ReviewImagePreviewData> {
  const deps = { ...defaultDeps(), ...depsInput };
  const diff = withSafeIndexOids(request.diff);
  const pathsAreSafe = isSafeGitPath(diff.path) && (diff.oldPath == null || isSafeGitPath(diff.oldPath));
  if (!scope.repoRoot || !pathsAreSafe || !isPreviewableImageDiff(diff)) {
    return { diffId: diff.id, old: null, new: null, maxBytes: IMAGE_PREVIEW_MAX_BYTES };
  }
  const sides = await resolveSides(scope.repoRoot, { ...request, diff }, deps);
  const [oldSide, newSide] = await Promise.all([
    readSide(scope.repoRoot, sides.old, deps),
    readSide(scope.repoRoot, sides.new, deps),
  ]);
  return {
    diffId: diff.id,
    old: oldSide,
    new: newSide,
    maxBytes: IMAGE_PREVIEW_MAX_BYTES,
  };
}
