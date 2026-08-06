import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { SCHEMA_VERSION, type KnowledgeFrontmatter, type KnowledgeType } from './types.js';

export interface KnowledgeFile {
  frontmatter: KnowledgeFrontmatter;
  body: string;
}

export function readKnowledgeFile(filePath: string): KnowledgeFile {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = matter(raw);
  const fm = parsed.data as Partial<KnowledgeFrontmatter>;
  if (!fm.id || !fm.type || !Array.isArray(fm.covers)) {
    throw new Error(`Invalid frontmatter in ${filePath}: missing id/type/covers`);
  }
  return {
    frontmatter: {
      id: fm.id,
      type: fm.type,
      covers: fm.covers,
      depends_on: fm.depends_on ?? [],
      last_synced_commit: fm.last_synced_commit ?? '',
      last_synced_at: fm.last_synced_at ?? '',
      stale: fm.stale ?? false,
      stale_reason: fm.stale_reason ?? null,
      // Backward compat: knowledge files written before auto_update existed have no
      // such field; treat absence as opt-in (true). Only an explicit `false` opts out.
      auto_update: fm.auto_update ?? true,
      schema_version: fm.schema_version ?? SCHEMA_VERSION,
    },
    body: parsed.content,
  };
}

export function writeKnowledgeFile(
  filePath: string,
  frontmatter: KnowledgeFrontmatter,
  body: string,
): void {
  const serialized = matter.stringify(body, frontmatter as unknown as Record<string, unknown>);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic-ish: write to .tmp then rename (rename is atomic on POSIX; on Windows it's
  // best-effort but still safer than direct write being interrupted mid-stream).
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, serialized, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Returns the standard H2-section skeleton body for a freshly-created knowledge file.
 * The body intentionally contains placeholder prose so agents have explicit slots to fill.
 *
 * IMPORTANT contract: the `## 是什么` H2 section's first paragraph is consumed verbatim
 * by `apps/desktop` (`projectContextInject.ts`) as a per-module summary in the session
 * system-prompt TOC. Renaming this heading silently breaks summary extraction —
 * downstream falls back to "(摘要缺失)" and the TOC loses signal. If you change it,
 * update the consumer's extractor at the same time.
 */
export function createSkeletonBody(id: string, type: KnowledgeType): string {
  if (type === 'module') {
    return [
      `# ${id}`,
      '',
      '## 是什么',
      '',
      '_TODO: 一段话讲清这个包/目录在系统里的位置。_',
      '',
      '## 关键抽象 / 核心代码地标',
      '',
      '_TODO: 列出关键 class / 函数 / 文件，每个一句话说明。_',
      '',
      '## 模块边界',
      '',
      '_TODO: 不依赖什么、被谁依赖、对外接口形态。_',
      '',
      '## 不要做的事',
      '',
      '_TODO: 反模式 / 常见误用。_',
      '',
      '## 演进备忘',
      '',
      '_仅追加。每次重大改动留一行：日期 - 做了什么 - 原因。_',
      '',
    ].join('\n');
  }
  return [
    `# ${id}`,
    '',
    '## 是什么',
    '',
    '_TODO: 这个跨切关注是什么、覆盖哪些代码路径。_',
    '',
    '## 关键约束',
    '',
    '_TODO: 涉及的不变量、契约、设计决策。_',
    '',
    '## 演进备忘',
    '',
    '_仅追加。_',
    '',
  ].join('\n');
}

export function makeFrontmatter(input: {
  id: string;
  type: KnowledgeType;
  covers: string[];
  head: string;
  syncedAt?: string;
}): KnowledgeFrontmatter {
  return {
    id: input.id,
    type: input.type,
    covers: input.covers,
    depends_on: [],
    last_synced_commit: input.head,
    last_synced_at: input.syncedAt ?? new Date().toISOString(),
    stale: false,
    stale_reason: null,
    auto_update: true,
    schema_version: SCHEMA_VERSION,
  };
}
