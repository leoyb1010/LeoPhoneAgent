/**
 * staging.ts —— learn 蒸馏产物的 staging 目录生命周期。
 *
 * 每个 run 一个隔离目录 {ownerRoot}/learn/staging/{runId}/,作为蒸馏 session 的
 * workingDir —— agent 用普通 Write 工具落盘,零新增 agent 工具。选 userData 而非
 * os.tmpdir:待审查提案要跨重启保留。done 后 scanStaging 提取提案文件清单交给
 * stagingValidation.pure 校验;失败/放弃/应用后 cleanupStaging 整目录删除。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ownerScopedUserDataPath } from '../appSessionState';
import { createLogger, maskPath } from '../logger';
import { isIgnoredSkillPackagePath } from '../skillhub/packageIgnore';
import type { ProposalFile } from './stagingValidation.pure';

const log = createLogger('learn-host:staging');

// 排除规则的单一事实源在 stagingValidation.pure(diff/扫描/剥除共用);此处
// re-export 维持既有导入路径。
export { REFERENCE_DIR_NAME } from './stagingValidation.pure';
import {
  MAX_PROPOSAL_FILES,
  MAX_PROPOSAL_TOTAL_BYTES,
  PROPOSAL_NOISE_ENTRIES as NOISE_ENTRIES,
  REFERENCE_DIR_NAME,
} from './stagingValidation.pure';

/** 文本读取上限 —— 超过按二进制处理(text=null,不参与 redaction 扫描)。 */
const TEXT_READ_MAX = 1024 * 1024;

export function stagingRoot(): string {
  return ownerScopedUserDataPath('learn', 'staging');
}

export function stagingDirForRun(runId: string): string {
  return path.join(stagingRoot(), runId);
}

export async function createStagingDir(runId: string): Promise<string> {
  const dir = stagingDirForRun(runId);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupStaging(runId: string): Promise<void> {
  const dir = stagingDirForRun(runId);
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`cleanupStaging failed for ${maskPath(dir)}:`, err);
  }
  // apply 成功路径的冻结区 wrapper(提案已被 moveDir 走,只剩空壳)也在这里
  // 顺带清 —— 否则空目录残留到下次重启 sweep(自查)。
  await fs.promises
    .rm(path.join(stagingRoot(), `${runId}.apply`), { recursive: true, force: true })
    .catch(() => undefined);
}

export interface ScanStagingResult {
  /** staging 下发现的候选 skill 目录(目录名 + 文件清单);无候选 = 空数组。
   *  violations:目录内的非常规文件系统条目(symlink/socket/fifo 等)——
   *  它们不会出现在审查 diff 里却会随整目录安装,必须拒绝(review 修正)。 */
  candidates: Array<{ dirName: string; absPath: string; files: ProposalFile[]; violations: string[] }>;
}

/**
 * done 后扫描 staging:列一级子目录(排除噪声),每个含 SKILL.md 的目录算一个
 * 候选,读出全部文件(文本内容随读,二进制/超大 text=null)。
 * 只读操作,不修改 staging;唯一目录约束由 controller 依据 candidates 数量判定。
 */
export async function scanStaging(runId: string): Promise<ScanStagingResult> {
  const root = stagingDirForRun(runId);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { candidates: [] };
  }

  const candidates: ScanStagingResult['candidates'] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (NOISE_ENTRIES.has(e.name) || e.name.startsWith('.')) continue;
    const absPath = path.join(root, e.name);
    const { files, violations } = await collectFiles(absPath);
    if (!files.some((f) => f.relPath === 'SKILL.md')) continue;
    candidates.push({ dirName: e.name, absPath, files, violations });
  }
  return { candidates };
}

async function collectFiles(rootDir: string): Promise<{ files: ProposalFile[]; violations: string[] }> {
  const out: ProposalFile[] = [];
  const violations: string[] = [];
  // 累计帽:超过提案上限就停止读盘(validateProposal 反正会拒绝)。不设的话,
  // agent 把整个 repo/docs 树误拷进 staging 时,每轮 done/rescan/apply 都要
  // 全量读几百 MB~GB,main 进程被白白拖住(Codex review)。
  let acceptedFileCount = 0;
  let acceptedTotalBytes = 0;
  let capExceeded = false;

  const recordCapViolation = (relPath: string): void => {
    if (capExceeded) return;
    capExceeded = true;
    violations.push(relPath);
  };

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => {
        if (a.name === 'SKILL.md') return -1;
        if (b.name === 'SKILL.md') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relForCheck = path.relative(rootDir, full).split(path.sep).join('/');
      // 审查集与安装集必须一致(review 修正):
      //   - 噪声/敏感/打包忽略路径 → 不进审查,apply 落盘时同样剥除
      //   - 非常规条目(symlink/socket/fifo)→ 记违规,校验层直接拒绝提案
      if (NOISE_ENTRIES.has(e.name) || isIgnoredSkillPackagePath(relForCheck)) continue;
      if (capExceeded) continue;
      if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) {
        violations.push(relForCheck);
        continue;
      }
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = relForCheck;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      // 单文件超过提案总量上限:不读(整读会把 main 进程内存顶爆,>2GiB 直接
      // 抛 ERR_FS_FILE_TOOLARGE),记违规交校验层拒绝 —— 这种文件本来也过不了
      // 总量校验,提前拒绝还能避免每轮重扫都白读一遍(自查)。
      if (stat.size > MAX_PROPOSAL_TOTAL_BYTES) {
        recordCapViolation(relForCheck);
        continue;
      }
      if (
        acceptedFileCount + 1 > MAX_PROPOSAL_FILES ||
        acceptedTotalBytes + stat.size > MAX_PROPOSAL_TOTAL_BYTES
      ) {
        recordCapViolation(relForCheck);
        continue;
      }
      acceptedFileCount += 1;
      acceptedTotalBytes += stat.size;
      let text: string | null = null;
      let contentHash: string | undefined;
      try {
        // 全量读取参与内容指纹:二进制/超上限文件不进 text(不做 redaction 扫描),
        // 但必须留 sha256 —— 指纹只记 size 的话,同尺寸换字节可以绕过 apply 的
        // "reviewed == installed" 校验(Codex review)。单文件上限受提案总量
        // 20MB 校验约束,一次性 readFile 可接受。
        const buf = await fs.promises.readFile(full);
        if (stat.size <= TEXT_READ_MAX && !buf.includes(0)) {
          text = buf.toString('utf8');
        } else {
          contentHash = crypto.createHash('sha256').update(buf).digest('hex');
        }
      } catch {
        text = null;
      }
      out.push({ relPath: rel, size: stat.size, text, ...(contentHash ? { contentHash } : {}) });
    }
  }

  await walk(rootDir);
  return { files: out, violations };
}

/**
 * apply 落盘前的剥除:把审查时被排除的路径(噪声/敏感/打包忽略)从最终目录
 * 删掉,保证"用户在 diff 里看到的 == 实际装进 ~/.agents/skills 的"。
 */
export async function stripUnreviewedEntries(skillDir: string): Promise<void> {
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(skillDir, full).split(path.sep).join('/');
      if (NOISE_ENTRIES.has(e.name) || isIgnoredSkillPackagePath(rel) || e.isSymbolicLink() || (!e.isDirectory() && !e.isFile())) {
        try {
          await fs.promises.rm(full, { recursive: true, force: true });
        } catch (err) {
          log.warn(`strip unreviewed entry failed: ${maskPath(full)}`, err);
          throw new Error(`failed to strip unreviewed entry ${rel}: ${String(err)}`);
        }
        continue;
      }
      if (e.isDirectory()) await walk(full);
    }
  }
  await walk(skillDir);
}

/**
 * 把 hub 参考 skill 的全部已发布文件写进 staging/_reference/<slug>/,
 * 蒸馏 agent 可读可复制(依赖的 scripts 必须 cp 进自己的 skill 目录 ——
 * 提案只收 skill 目录内的文件)。路径做防逃逸校验。
 */
export async function writeReferenceFiles(
  runId: string,
  slug: string,
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const refRoot = path.join(stagingDirForRun(runId), REFERENCE_DIR_NAME, slug);
  await fs.promises.mkdir(refRoot, { recursive: true });
  for (const file of files) {
    const dest = path.resolve(refRoot, file.path);
    if (!dest.startsWith(path.resolve(refRoot) + path.sep) && dest !== path.resolve(refRoot)) {
      log.warn(`skip reference file escaping refRoot: ${file.path}`);
      continue;
    }
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, file.content, 'utf8');
  }
  return refRoot;
}

/**
 * 把提案目录改名为 frontmatter name(目录名 ≠ name 时的代码化修正)。
 * 目标已存在(模型同时建了两个目录之类)→ 抛错交 controller 转 failed。
 */
export async function renameProposalDir(absPath: string, newName: string): Promise<string> {
  const target = path.join(path.dirname(absPath), newName);
  await fs.promises.rename(absPath, target);
  return target;
}

/** apply 冻结区(`<runId>.apply`):不是合法 runId,崩溃残留由 sweepOrphans 清。 */
function applyFreezeWrapper(runId: string): string {
  return path.join(stagingRoot(), `${runId}.apply`);
}

/**
 * 冻结提案:把提案目录从蒸馏会话的 workingDir 原子 rename 到冻结区。
 * awaiting-review 期间会话仍开放,用户可能在修订回合尚未结束时点应用——
 * 扫描后、落盘前的迟到写入会把未审查内容装进系统(apply 的 TOCTOU)。
 * rename 之后会话再写文件只会在原 staging 里重建目录,物理上进不了本次
 * 安装;校验必须在冻结后的目录上进行(collectProposalFiles)。同卷,原子。
 */
export async function freezeProposal(runId: string, dirName: string): Promise<string> {
  const wrapper = applyFreezeWrapper(runId);
  await fs.promises.rm(wrapper, { recursive: true, force: true });
  await fs.promises.mkdir(wrapper, { recursive: true });
  const dest = path.join(wrapper, dirName);
  await fs.promises.rename(path.join(stagingDirForRun(runId), dirName), dest);
  return dest;
}

/** 冻结目录的文件采集(校验来源必须是冻结副本,不能复用冻结前的扫描结果)。 */
export async function collectProposalFiles(
  rootDir: string,
): Promise<{ files: ProposalFile[]; violations: string[] }> {
  return collectFiles(rootDir);
}

/**
 * 冻结放回:校验/落盘失败时把冻结目录还回 staging,用户可继续对话迭代。
 * 若蒸馏会话此间已重建同名目录,以更新的会话产物为准,丢弃冻结副本。
 */
export async function unfreezeProposal(frozenAbsPath: string, runId: string): Promise<void> {
  const dest = path.join(stagingDirForRun(runId), path.basename(frozenAbsPath));
  try {
    if (fs.existsSync(dest)) {
      await fs.promises.rm(frozenAbsPath, { recursive: true, force: true });
    } else {
      await fs.promises.rename(frozenAbsPath, dest);
    }
  } catch (err) {
    log.warn(`unfreezeProposal failed for ${maskPath(frozenAbsPath)}:`, err);
  }
  await fs.promises
    .rm(applyFreezeWrapper(runId), { recursive: true, force: true })
    .catch(() => undefined);
}

/**
 * 审查基线用的目标目录指纹 —— 与 skillhub 的 computeFolderHash 不同,**覆盖
 * 目录里的每一个条目**(不吃 package ignore):learn apply 是整目录替换,
 * .env / node_modules 等被 ignore 的路径同样会被删掉,指纹漏掉它们的话,
 * "审查后目标被改动"的 apply 门就对这些路径失明(Codex review)。
 * 取 rel+type+size+mtimeMs 的元数据哈希:够灵敏(增删改名/内容写入都会动
 * mtime),又不用为 node_modules 级体量做全量内容 hash。
 */
export async function computeTargetDirFingerprint(dir: string): Promise<string> {
  const entries: string[] = [];
  async function walk(cur: string): Promise<void> {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of dirents) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(full);
      } catch {
        continue;
      }
      const type = st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : st.isFile() ? 'f' : 'o';
      entries.push(`${rel}\0${type}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
      if (st.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  entries.sort();
  const h = crypto.createHash('sha256');
  for (const line of entries) {
    h.update(line);
    h.update('\n');
  }
  return h.digest('hex');
}

/**
 * 启动 sweep:删除没有对应 run 记录、或对应 run 已终态的孤儿 staging 目录。
 * keepRunIds = 仍需保留 staging 的 run(awaiting-review / 进行中)。
 */
export async function sweepOrphans(keepRunIds: ReadonlySet<string>): Promise<void> {
  const root = stagingRoot();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return; // 目录不存在 = 无孤儿
  }
  for (const e of entries) {
    if (!e.isDirectory() || keepRunIds.has(e.name)) continue;
    const dir = path.join(root, e.name);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      log.info(`swept orphan staging dir ${maskPath(dir)}`);
    } catch (err) {
      log.warn(`sweep failed for ${maskPath(dir)}:`, err);
    }
  }
}
