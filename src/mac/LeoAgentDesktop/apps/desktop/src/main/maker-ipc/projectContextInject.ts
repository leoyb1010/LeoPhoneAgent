/**
 * project-context inject helper（main 进程）
 *
 * 在 createSession IPC 之前调用，向 systemPrompt 注入一段「项目模块知识 TOC + 摘要」，
 * 引导 agent 用 Read 工具按需打开完整 .md 文件取细节。
 *
 * 数据源唯一性：直接读 `.cindy/project-knowledge/TOC.md`。这是
 * `project-context` CLI 在 init/update/refresh 时预生成的派生物，跟 manifest 和各
 * 模块 .md 一起入 git、由 CI 集中维护。desktop 端不做任何 markdown 解析、不做
 * 摘要抽取、不感知 manifest schema —— 渲染逻辑统一在 `packages/project-context/src/toc.ts`。
 *
 * 读不到 TOC.md（文件缺失 / 空 / IO 错）= 该工作目录没有可用的项目知识库，
 * 直接返回 `injected: false` 不注入；session 仍可正常创建。这是有意行为：
 * 没有 TOC.md 就说明 `pctx` 还没在这个仓库跑过，应该跑一次 init/update 而不是
 * 让 desktop 临时拼一份可能跟 CI 产物风格不一致的 fallback TOC。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger.js';
import { migrateLegacyXdmakerDir } from '../utils/legacyXdmakerMigration.js';

const log = createLogger('project-context-inject');

const TOC_REL_PATH = path.join('.cindy', 'project-knowledge', 'TOC.md');

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { result: InjectResult; ts: number }>();
const inflight = new Map<string, Promise<InjectResult>>();

export interface InjectResult {
  injected: boolean;
  /** 拼好的 markdown 内容（含 wrapper），仅在 injected=true 时返回。 */
  content?: string;
  /** 跳过原因，仅在 injected=false 时返回。供 handler 记 log。 */
  reason?: string;
}

export async function tryInjectProjectContext(workingDir: string): Promise<InjectResult> {
  if (!workingDir) {
    return { injected: false, reason: 'no-working-dir' };
  }

  const now = Date.now();
  const cached = cache.get(workingDir);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    log.debug('project-context inject cache hit', { workingDir });
    return cached.result;
  }

  let pending = inflight.get(workingDir);
  if (!pending) {
    pending = readToc(workingDir);
    inflight.set(workingDir, pending);
    pending.finally(() => inflight.delete(workingDir));
  }
  const result = await pending;
  cache.set(workingDir, { result, ts: Date.now() });
  return result;
}

async function readToc(workingDir: string): Promise<InjectResult> {
  const migration = await migrateLegacyXdmakerDir(workingDir);
  if (!migration.complete) return { injected: false, reason: 'migration-incomplete' };
  const tocPath = path.join(workingDir, TOC_REL_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(tocPath, 'utf8');
  } catch {
    return { injected: false, reason: 'no-toc-file' };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { injected: false, reason: 'empty-toc-file' };
  }

  const content = `<project-context-toc>\n${trimmed}\n</project-context-toc>`;
  log.debug('project-context inject from TOC.md', { bytes: content.length });
  return { injected: true, content };
}
