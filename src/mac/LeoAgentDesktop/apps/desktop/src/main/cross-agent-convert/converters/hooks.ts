/**
 * hooks converter:
 *   .claude/hooks/ + .claude/settings.json (hooks段)  ↔  .codex/hooks/ + .codex/hooks.json
 *
 * 工作内容（双向）：
 *  1. 复制脚本目录：源 hooks/ 下文件全部 copy 到目标 hooks/，目标已存在的同名文件跳过
 *  2. 重写脚本路径：源端 settings 里 command 字符串的 ".claude/hooks/" → 目标端的 ".codex/hooks/"
 *  3. 事件名：Codex 与 Claude Code 都用 camelCase（PreToolUse/PostToolUse/UserPromptSubmit/
 *     Stop/SessionStart），共有事件直接同名透传；两端独有事件（Claude 的 Notification/
 *     SubagentStop/PreCompact、Codex 的 PermissionRequest）也原样透传，由目标端忽略未识别项。
 *     见 https://developers.openai.com/codex/hooks
 *  4. 写入目标"索引"：
 *      - to-codex: 写到 .codex/hooks.json
 *      - to-claude: merge 进 .claude/settings.json 的 hooks 字段（不覆盖现有）
 *
 * 安全保证：
 *  - 索引文件已有同名 hook event/key → 跳过
 *  - 脚本目录里同名文件 → 跳过
 *  - 任何子项（脚本 / 索引 entry）失败 → 该项失败但不阻塞其他
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { MigrationItem, MigrationStepStatus } from '../types.js';

export interface ConvertOutcome {
  status: MigrationStepStatus;
  detail?: string;
}

const CLAUDE_HOOKS_PATH_PATTERN = /\.claude\/hooks\//g;
const CODEX_HOOKS_PATH_PATTERN = /\.codex\/hooks\//g;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(p: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return null;
    throw err;
  }
}

/** 复制 srcDir 下所有文件到 dstDir（不递归子目录的子目录是 OK 的：hooks 默认平铺）。已存在文件跳过。 */
async function copyHookScripts(srcDir: string, dstDir: string): Promise<{ copied: number; skipped: number }> {
  let copied = 0;
  let skipped = 0;
  if (!(await exists(srcDir))) return { copied, skipped };
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const srcPath = path.join(srcDir, ent.name);
    const dstPath = path.join(dstDir, ent.name);
    if (await exists(dstPath)) {
      skipped += 1;
      continue;
    }
    try {
      await fs.copyFile(srcPath, dstPath, fs.constants.COPYFILE_EXCL);
      copied += 1;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === 'EEXIST') {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  return { copied, skipped };
}

function rewritePathInString(s: string, direction: MigrationItem['direction']): string {
  if (direction === 'to-codex') return s.replace(CLAUDE_HOOKS_PATH_PATTERN, '.codex/hooks/');
  return s.replace(CODEX_HOOKS_PATH_PATTERN, '.claude/hooks/');
}

function rewriteHookEntry(entry: unknown, direction: MigrationItem['direction']): unknown {
  if (entry === null) return entry;
  if (typeof entry === 'string') return rewritePathInString(entry, direction);
  if (Array.isArray(entry)) return entry.map((e) => rewriteHookEntry(e, direction));
  if (typeof entry === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      out[k] = rewriteHookEntry(v, direction);
    }
    return out;
  }
  return entry;
}

/** to-codex: 读 settings.json hooks 段 + 复制脚本 → 写 .codex/hooks.json */
async function convertToCodex(item: MigrationItem): Promise<ConvertOutcome> {
  const claudeSettingsPath = path.join(path.dirname(item.source), 'settings.json');
  const claudeHooksDir = item.source; // <wd>/.claude/hooks/
  const codexHooksJson = item.target; // <wd>/.codex/hooks.json
  const codexHooksDir = path.join(path.dirname(codexHooksJson), 'hooks');

  // 1. 复制脚本
  let scriptResult = { copied: 0, skipped: 0 };
  try {
    scriptResult = await copyHookScripts(claudeHooksDir, codexHooksDir);
  } catch (err) {
    return { status: 'failed', detail: `脚本复制失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 2. 解析 settings.json 抽 hooks 段
  let sourceSettings: Record<string, unknown> | null = null;
  try {
    const parsed = await readJsonIfExists(claudeSettingsPath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      sourceSettings = parsed as Record<string, unknown>;
    }
  } catch (err) {
    return { status: 'failed', detail: `settings.json 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  const claudeHooks = (sourceSettings?.hooks ?? null) as Record<string, unknown> | null;

  if (!claudeHooks && scriptResult.copied === 0) {
    return { status: 'skipped', detail: '无可迁移内容' };
  }

  // 3. 已有 codex hooks.json → merge；否则新建
  let existing: Record<string, unknown> = {};
  const hadExisting = await exists(codexHooksJson);
  if (hadExisting) {
    const parsed = await readJsonIfExists(codexHooksJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  }

  let added = 0;
  let skipped = 0;
  if (claudeHooks) {
    for (const [eventName, eventConfig] of Object.entries(claudeHooks)) {
      if (eventName in existing) {
        skipped += 1;
        continue;
      }
      existing[eventName] = rewriteHookEntry(eventConfig, 'to-codex');
      added += 1;
    }
  }

  if (added === 0 && scriptResult.copied === 0) {
    return { status: 'skipped', detail: '所有 hook 已存在' };
  }

  await fs.mkdir(path.dirname(codexHooksJson), { recursive: true });
  await fs.writeFile(codexHooksJson, JSON.stringify(existing, null, 2), 'utf8');

  const parts: string[] = [];
  if (scriptResult.copied > 0) parts.push(`脚本 ${scriptResult.copied}`);
  if (added > 0) parts.push(`索引 ${added}`);
  if (skipped > 0) parts.push(`跳过 ${skipped}`);
  return { status: 'success', detail: parts.join(', ') };
}

/** to-claude: 读 codex hooks.json + 复制脚本 → merge 进 .claude/settings.json hooks 段 */
async function convertToClaude(item: MigrationItem): Promise<ConvertOutcome> {
  const codexHooksJson = item.source; // <wd>/.codex/hooks.json
  const codexHooksDir = path.join(path.dirname(codexHooksJson), 'hooks');
  const claudeSettingsPath = item.target; // <wd>/.claude/settings.json
  const claudeHooksDir = path.join(path.dirname(claudeSettingsPath), 'hooks');

  // 1. 复制脚本
  let scriptResult = { copied: 0, skipped: 0 };
  try {
    scriptResult = await copyHookScripts(codexHooksDir, claudeHooksDir);
  } catch (err) {
    return { status: 'failed', detail: `脚本复制失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 2. 解析 codex hooks.json
  let codexHooks: Record<string, unknown> = {};
  try {
    const parsed = await readJsonIfExists(codexHooksJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      codexHooks = parsed as Record<string, unknown>;
    }
  } catch (err) {
    return { status: 'failed', detail: `hooks.json 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 3. merge 到 settings.json hooks 段
  let settings: Record<string, unknown> = {};
  const hadSettings = await exists(claudeSettingsPath);
  if (hadSettings) {
    const parsed = await readJsonIfExists(claudeSettingsPath);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  }
  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown>;

  let added = 0;
  let skipped = 0;
  for (const [eventName, eventConfig] of Object.entries(codexHooks)) {
    if (eventName in existingHooks) {
      skipped += 1;
      continue;
    }
    existingHooks[eventName] = rewriteHookEntry(eventConfig, 'to-claude');
    added += 1;
  }

  if (added === 0 && scriptResult.copied === 0) {
    return { status: 'skipped', detail: '所有 hook 已存在' };
  }

  settings.hooks = existingHooks;
  await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
  await fs.writeFile(claudeSettingsPath, JSON.stringify(settings, null, 2), 'utf8');

  const parts: string[] = [];
  if (scriptResult.copied > 0) parts.push(`脚本 ${scriptResult.copied}`);
  if (added > 0) parts.push(`索引 ${added}`);
  if (skipped > 0) parts.push(`跳过 ${skipped}`);
  return { status: 'success', detail: parts.join(', ') };
}

export async function convertHooks(item: MigrationItem): Promise<ConvertOutcome> {
  if (item.direction === 'to-codex') return convertToCodex(item);
  return convertToClaude(item);
}
