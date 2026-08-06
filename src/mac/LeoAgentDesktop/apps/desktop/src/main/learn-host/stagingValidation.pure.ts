/**
 * stagingValidation.pure.ts —— 蒸馏产物(staging 扫描结果)的纯校验。
 *
 * 输入是 staging.ts 扫描出的文件清单 + SKILL.md 文本,本模块不做任何 IO,
 * 方便单测直接构造输入。校验失败 → run 转 failed;redaction 命中不阻断,
 * 作为 warning 带给审查 UI 高亮(第二层防线,第三层是人工 diff 审查)。
 */

import { createHash } from 'node:crypto';

import matter from 'gray-matter';

import { parseAndValidateFrontmatter } from '../skillhub/frontmatterValidation';
import { isIgnoredSkillPackagePath } from '../skillhub/packageIgnore';
import { redactSensitive } from './redaction';

/** hub 参考材料在 staging 内的目录名(扫描/审查/安装全链路排除)。 */
export const REFERENCE_DIR_NAME = '_reference';

/** agent 运行噪声 —— 审查与安装都排除的目录/文件(不属于 skill 产物)。 */
export const PROPOSAL_NOISE_ENTRIES: ReadonlySet<string> = new Set([
  '.claude',
  '.agents',
  '.codex',
  '.git',
  'node_modules',
  'CLAUDE.md',
  'AGENTS.md',
  '.DS_Store',
  REFERENCE_DIR_NAME,
]);

/**
 * 审查/安装排除谓词 —— diff、扫描、apply 剥除共用同一套规则,保证
 * "用户在 diff 里看到的 == 实际装进 ~/.agents/skills 的"(审查集 == 安装集)。
 * 逐级前缀检查:中间目录命中忽略规则时,其下所有路径同样排除
 * (与 staging 扫描的 walk 语义一致)。
 */
/**
 * 提案内容指纹 —— 扫描通过时记录,apply 时对冻结副本重算比对:
 * "装进系统的 == 用户最后审查过的"必须逐字节成立,冻结只能挡住扫描之后的
 * 写入,挡不住"修订回合已改写、但尚未 done/重扫"的点击前写入(Codex review)。
 * 输入即扫描器产出的文件清单(路径排序,二进制以 size 参与)。
 */
export function computeProposalFingerprint(files: ProposalFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    h.update(f.relPath);
    h.update('\0');
    h.update(String(f.size));
    h.update('\0');
    h.update(f.text ?? `binary:${f.contentHash ?? '<unhashed>'}`);
    h.update('\0');
  }
  return h.digest('hex');
}

export function isExcludedProposalPath(relPath: string): boolean {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.some((p) => PROPOSAL_NOISE_ENTRIES.has(p))) return true;
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (isIgnoredSkillPackagePath(prefix)) return true;
  }
  return false;
}

/** skill 名规则 —— 与 registry sanitizeSkillName(^[a-z0-9-]{1,200}$)一致,
 *  另按惯例要求以字母/数字开头(纯 '-' 开头的目录名对 CLI 工具不友好)。 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

/** 单 skill 文件数上限(staging 扫描已排除 agent 噪声目录)。 */
export const MAX_PROPOSAL_FILES = 200;
/** 单 skill 总字节上限,与 skillhub 安装解压上限同数量级。 */
export const MAX_PROPOSAL_TOTAL_BYTES = 20 * 1024 * 1024;

/** staging 扫描出的一个文件(路径为 skill 目录内的 POSIX 相对路径)。 */
export interface ProposalFile {
  relPath: string;
  size: number;
  /** 文本文件的内容;二进制/超大文件为 null(不参与 redaction 扫描)。 */
  text: string | null;
  /** text=null 时的内容 sha256 —— 指纹必须覆盖字节,同尺寸换字节不能绕过
   *  apply 的 reviewed == installed 校验(Codex review)。 */
  contentHash?: string;
}

export interface ProposalInput {
  /** staging 下 skill 目录的目录名。 */
  dirName: string;
  files: ProposalFile[];
  /** 目录内的非常规条目(symlink 等,staging 扫描收集)—— 有即拒绝。 */
  violations?: string[];
}

export type ProposalValidation =
  | {
      ok: true;
      /** frontmatter 里的 name(权威名;目录名不一致时调用方按此重命名目录)。 */
      skillName: string;
      /** 目录名与 frontmatter name 不一致(调用方需重命名目录)。 */
      needsRename: boolean;
      /** 产物文本里疑似敏感内容的类别(去重;不阻断)。 */
      redactionWarnings: string[];
    }
  | { ok: false; reason: string };

/**
 * 校验一个提案 skill 目录。规则:
 *   1. 必须含 SKILL.md 且 frontmatter 过 skillhub 校验(name/description 必填)
 *   2. frontmatter name 合法(^[a-z0-9][a-z0-9-]*$);与目录名不一致按 frontmatter
 *      为准(代码化修正,不失败 —— 模型偶尔在这步跑偏,没必要整轮重来)
 *   3. 文件数 / 总字节数上限
 *   4. 全部文本文件过 redactSensitive,命中类别聚合为 warnings
 */
export function validateProposal(input: ProposalInput): ProposalValidation {
  if (input.violations && input.violations.length > 0) {
    // symlink 会被整目录安装却不出现在审查 diff 里 —— 无条件拒绝(review 修正)
    return {
      ok: false,
      reason: `proposal contains non-regular filesystem entries (symlinks etc.): ${input.violations.slice(0, 5).join(', ')}`,
    };
  }
  const skillMd = input.files.find((f) => f.relPath === 'SKILL.md');
  if (!skillMd) {
    return { ok: false, reason: 'SKILL.md missing in proposal directory' };
  }
  if (skillMd.text == null) {
    return { ok: false, reason: 'SKILL.md is not readable as text' };
  }

  const { issues } = parseAndValidateFrontmatter(skillMd.text, 'skill');
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    return { ok: false, reason: `SKILL.md frontmatter invalid — ${detail}` };
  }

  // parseAndValidateFrontmatter 只回 issues 不回数据,这里用同一 parser 取 name
  // (上一步已保证可 parse 且 name 非空,parse 异常按防御处理)。
  let skillName = '';
  try {
    const parsed = matter(skillMd.text);
    skillName = String((parsed.data as Record<string, unknown>).name ?? '').trim();
  } catch {
    return { ok: false, reason: 'SKILL.md frontmatter unparseable' };
  }
  if (!SKILL_NAME_RE.test(skillName)) {
    return {
      ok: false,
      reason: `frontmatter name "${skillName}" invalid — expected lowercase [a-z0-9-], starting with a letter or digit`,
    };
  }

  if (input.files.length > MAX_PROPOSAL_FILES) {
    return { ok: false, reason: `too many files: ${input.files.length} (limit ${MAX_PROPOSAL_FILES})` };
  }
  const totalBytes = input.files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_PROPOSAL_TOTAL_BYTES) {
    return { ok: false, reason: `proposal too large: ${totalBytes} bytes (limit ${MAX_PROPOSAL_TOTAL_BYTES})` };
  }

  const warnings = new Set<string>();
  for (const f of input.files) {
    if (f.text == null) continue;
    const r = redactSensitive(f.text);
    for (const c of r.categories) warnings.add(c);
  }

  return {
    ok: true,
    skillName,
    needsRename: input.dirName !== skillName,
    redactionWarnings: [...warnings],
  };
}
