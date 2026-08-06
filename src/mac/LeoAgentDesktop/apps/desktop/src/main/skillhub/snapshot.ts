/**
 * skillhub/snapshot.ts — 本地保存上次发布版的 skill 文件夹快照
 *
 * 作用:让 DetailView 在 dirty 时能跟"我上次发布的版本"做真正的文件 diff,
 * 而不是只对比 sha256。
 *
 * 设计:
 *   - publish 成功后,把当前 skill 目录原样复制到 userData/skillhub-snapshots/{name}/
 *     (使用 base64url(name) 做目录名,避免 ' / ' 这种少见但合法的 skill 名打穿)
 *   - 每个 skill 只保留最新一份(覆盖),不分版本
 *   - 排除规则 = folderHash 一致(明确高风险 / 平台噪声路径),保证 hash 对得上
 *   - 历史已发布但未走过本流程的 skill → 没快照,DiffPanel 显示"无快照"提示
 *
 * 失败容忍:写快照失败不应该影响 publish 结果(commit 已成功),只 log warning。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';

import { createLogger, maskPath } from '../logger';
import { isIgnoredSkillPackagePath } from './packageIgnore';

const log = createLogger('skillhub:snapshot');

// ── 路径辅助 ─────────────────────────────────────────────────────────────────

/**
 * skill name → 安全的目录名。base64url 是 path-safe + 无大小写歧义,
 * 跨平台都能直接当目录用。
 */
function safeDirName(name: string): string {
  return Buffer.from(name, 'utf8').toString('base64url');
}

function snapshotsRoot(): string {
  return path.join(app.getPath('userData'), 'skillhub-snapshots');
}

export function getSnapshotPath(name: string): string {
  return path.join(snapshotsRoot(), safeDirName(name));
}

export function snapshotExists(name: string): boolean {
  try {
    return fs.statSync(getSnapshotPath(name)).isDirectory();
  } catch {
    return false;
  }
}

// ── 排除规则(与 folderHash 一致) ────────────────────────────────────────────

// ── 复制 ────────────────────────────────────────────────────────────────────

async function copyDir(src: string, dst: string, rootDir = src): Promise<void> {
  await fs.promises.mkdir(dst, { recursive: true });
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const srcPath = path.join(src, e.name);
    const rel = path.relative(rootDir, srcPath).split(path.sep).join('/');
    if (isIgnoredSkillPackagePath(rel)) continue;
    const dstPath = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyDir(srcPath, dstPath, rootDir);
    } else if (e.isFile()) {
      await fs.promises.copyFile(srcPath, dstPath);
    }
    // symlink/socket 跳过(folderHash 也不算它们)
  }
}

async function rmDir(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`rmDir failed for ${maskPath(dir)}:`, err);
  }
}

/**
 * 把 absolutePath 整个目录原样拷到 userData/skillhub-snapshots/{name}/。
 * 已存在则先整体删掉再写,保证不会留旧文件残骸。
 *
 * 失败抛错,调用方决定是否吞掉(publish 流程吞)。
 */
export async function writeSnapshot(absolutePath: string, name: string): Promise<void> {
  const dst = getSnapshotPath(name);
  await rmDir(dst);
  await copyDir(absolutePath, dst);
  log.info(`wrote snapshot for ${name} → ${dst}`);
}

// ── diff 计算 ──────────────────────────────────────────────────────────────

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface FileChange {
  /** POSIX 相对路径 */
  path: string;
  kind: ChangeKind;
  isBinary: boolean;
  /** 文本文件内容(modified/removed → 旧版,added 时为空字符串) */
  oldContent: string;
  /** 文本文件内容(modified/added → 新版,removed 时为空字符串) */
  newContent: string;
  /** 二进制文件的字节数,用于 UI 显示 */
  oldSize: number;
  newSize: number;
}

const BINARY_EXTENSIONS = new Set([
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 音视频
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  // 压缩 / 二进制
  '.zip', '.gz', '.tar', '.7z', '.bin', '.exe', '.dll', '.so', '.dylib',
  // 文档(非纯文本)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // 其他
  '.psd', '.ai', '.sketch', '.fig',
]);

const TEXT_READ_MAX = 1024 * 1024; // 1MB 文本文件上限,超过当二进制处理

function looksBinary(filePath: string, fileSize: number): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (fileSize > TEXT_READ_MAX) return true;
  return false;
}

function streamSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

interface FileEntry {
  relPath: string;
  size: number;
  sha256: string;
}

async function listFiles(
  rootDir: string,
  skip?: (rel: string, size: number | null) => boolean,
): Promise<Map<string, FileEntry>> {
  const map = new Map<string, FileEntry>();

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      if (isIgnoredSkillPackagePath(rel)) continue;
      if (e.isDirectory()) {
        // 目录级剪枝:调用方声明整棵子树无关(如 learn 的 _reference/)时不下钻,
        // 避免为注定丢弃的内容做全量 hash(size=null 表示目录)。
        if (skip?.(rel, null)) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const stat = await fs.promises.stat(full);
      if (skip?.(rel, stat.size)) continue;
      const sha256 = await streamSha256(full);
      map.set(rel, { relPath: rel, size: stat.size, sha256 });
    }
  }

  await walk(rootDir);
  return map;
}

async function readText(filePath: string): Promise<string> {
  // 二进制安全读法:先读 buffer,再 toString。如果文件不存在或无法读取,返回空串
  // (调用方靠 isBinary/size 字段判断显示形式,不靠 content 是否为空)
  try {
    const buf = await fs.promises.readFile(filePath);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

export interface SnapshotDiffResult {
  hasSnapshot: boolean;
  changes: FileChange[];
}

/**
 * 通用两目录文件级 diff:oldDir(可为 null = 全新增)vs newDir。
 * 一次性把所有 modified/added/removed 的文本内容读出来,调用方一次拿全。
 * 只读操作。skillhub snapshot diff 与 learn 提案 diff 共用(勿再复制此逻辑)。
 */
export async function computeTwoDirDiff(
  oldDir: string | null,
  newDir: string,
  // 两侧独立 skip:旧侧(安装目录)的内容会被整目录替换删除,漏列 = 用户看不见
  // 的删除,谓词必须比新侧(提案)保守 —— 调用方分别声明,不共用一个。
  opts?: {
    skipOld?: (rel: string, size: number | null) => boolean;
    skipNew?: (rel: string, size: number | null) => boolean;
  },
): Promise<FileChange[]> {
  const [oldMap, newMap] = await Promise.all([
    oldDir ? listFiles(oldDir, opts?.skipOld) : Promise.resolve(new Map<string, FileEntry>()),
    listFiles(newDir, opts?.skipNew),
  ]);

  const changes: FileChange[] = [];
  const allPaths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);

  for (const rel of allPaths) {
    const oldEntry = oldMap.get(rel);
    const newEntry = newMap.get(rel);

    let kind: ChangeKind;
    if (oldEntry && !newEntry) kind = 'removed';
    else if (!oldEntry && newEntry) kind = 'added';
    else if (oldEntry && newEntry) {
      if (oldEntry.sha256 === newEntry.sha256) continue; // 完全没变
      kind = 'modified';
    } else continue; // 不可能

    const oldPath = oldEntry && oldDir ? path.join(oldDir, rel.split('/').join(path.sep)) : '';
    const newPath = newEntry ? path.join(newDir, rel.split('/').join(path.sep)) : '';
    const isBinary =
      looksBinary(rel, Math.max(oldEntry?.size ?? 0, newEntry?.size ?? 0));

    const change: FileChange = {
      path: rel,
      kind,
      isBinary,
      oldContent: '',
      newContent: '',
      oldSize: oldEntry?.size ?? 0,
      newSize: newEntry?.size ?? 0,
    };

    if (!isBinary) {
      // 一次性把内容读出来,renderer 不再需要二次 IPC
      if (oldEntry) change.oldContent = await readText(oldPath);
      if (newEntry) change.newContent = await readText(newPath);
    }

    changes.push(change);
  }

  // 字典序排好,UI 文件树展示稳定
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

/**
 * 计算 currentDir 和 snapshot(若存在) 之间的文件级 diff。
 * computeTwoDirDiff 的薄包装(oldDir = snapshot 目录)。
 *
 * 不会动盘(只读操作),失败不抛(空结果 + hasSnapshot=false)。
 */
export async function computeSnapshotDiff(
  absolutePath: string,
  name: string,
): Promise<SnapshotDiffResult> {
  if (!snapshotExists(name)) {
    log.info(`no snapshot for ${name}`);
    return { hasSnapshot: false, changes: [] };
  }
  const snapshotDir = getSnapshotPath(name);
  const changes = await computeTwoDirDiff(snapshotDir, absolutePath);

  log.info(
    `diff for ${name}: ${changes.length} changes ` +
      `(M=${changes.filter((c) => c.kind === 'modified').length} ` +
      `A=${changes.filter((c) => c.kind === 'added').length} ` +
      `R=${changes.filter((c) => c.kind === 'removed').length})`,
  );

  return { hasSnapshot: true, changes };
}
