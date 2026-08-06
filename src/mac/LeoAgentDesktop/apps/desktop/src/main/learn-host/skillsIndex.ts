/**
 * skillsIndex.ts —— 已装 skill 清单(learn 的"改 vs 加"决策依据)。
 *
 * 蒸馏前把 ~/.agents/skills/(learn 落盘与市场安装的共享根)下所有 skill 的
 * name/description 注入 prompt,让模型显式决策:同域已有 skill → 沿用
 * 原名出改进版(落盘自动走"与已装版本 diff+备份");否则才新建。没有这份
 * 清单,模型只能碰运气自己去翻,"改还是加"就不可复现(规则 9)。
 *
 * 扫描是只读 fs 遍历,失败静默降级(清单缺失不阻断蒸馏)。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { createLogger } from '../logger';
import { redactSensitive } from './redaction';

const log = createLogger('learn-host:skills-index');

/** 清单条数上限(超出截断并注明 —— no silent caps)。 */
export const SKILLS_INDEX_MAX = 100;
/** description 展示截断。 */
const DESC_CAP = 160;

export interface InstalledSkillEntry {
  name: string;
  description: string;
  /** skill 目录绝对路径 —— 仅供内部定位;prompt 清单不暴露本地路径。 */
  absolutePath: string;
}

function redactPromptMetadata(value: string): string {
  return redactSensitive(value).text.replace(/\s+/g, ' ').trim();
}

/** 纯格式化:清单 → prompt 块(空清单返回空串;供单测)。
 *  清单只暴露名称/描述,不暴露本地路径(Codex review):否则 agent 可自行 Read
 *  原始 SKILL.md,绕过 controller 的 redactSensitive 预处理。 */
export function formatSkillsIndexBlock(entries: InstalledSkillEntry[], truncatedCount = 0): string {
  if (entries.length === 0) return '';
  const lines = entries.map(
    (e) => {
      const name = redactPromptMetadata(e.name) || '(unnamed skill)';
      const description = redactPromptMetadata(e.description) || '(no description)';
      return `- ${name}: ${description}`;
    },
  );
  const tail = truncatedCount > 0 ? `\n(${truncatedCount} more installed skill(s) omitted.)` : '';
  return `${lines.join('\n')}${tail}`;
}

/** 扫描全局 skill 根,读每个 SKILL.md 的 frontmatter name/description。 */
export async function listInstalledSkills(): Promise<{ entries: InstalledSkillEntry[]; truncatedCount: number }> {
  const root = path.join(os.homedir(), '.agents', 'skills');
  let dirs: string[];
  try {
    const dirents = (await fs.readdir(root, { withFileTypes: true })).filter(
      (e) => !e.name.startsWith('.'),
    );
    const names: string[] = [];
    for (const e of dirents) {
      if (e.isDirectory()) {
        names.push(e.name);
        continue;
      }
      // 共享 skill 链接流程会把既有 Claude/Codex 全局 skill 以 symlink 形式挂进
      // 本根 —— 只认真实目录会漏掉它们,模型看不到已装清单就会蒸出近重复的新
      // skill 而不是改进原版(Codex review)。跟随链接,目标是目录即计入;
      // 后续 SKILL.md 读取本身走 follow 语义,坏链接在下方 catch 静默跳过。
      if (e.isSymbolicLink()) {
        try {
          if ((await fs.stat(path.join(root, e.name))).isDirectory()) names.push(e.name);
        } catch {
          // 悬空链接,跳过
        }
      }
    }
    dirs = names.sort();
  } catch {
    return { entries: [], truncatedCount: 0 };
  }

  const entries: InstalledSkillEntry[] = [];
  let truncatedCount = 0;
  for (const dirName of dirs) {
    if (entries.length >= SKILLS_INDEX_MAX) {
      truncatedCount = dirs.length - SKILLS_INDEX_MAX;
      break;
    }
    const skillDir = path.join(root, dirName);
    try {
      const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const name = redactPromptMetadata(String(data.name ?? dirName)) || dirName;
      const description = redactPromptMetadata(String(data.description ?? '')).slice(0, DESC_CAP);
      entries.push({ name, description, absolutePath: skillDir });
    } catch (err) {
      // 无 SKILL.md / 解析失败的目录跳过(不是合法 skill)
      log.debug?.('skip skill dir:', dirName, err);
    }
  }
  return { entries, truncatedCount };
}
