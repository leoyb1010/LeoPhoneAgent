#!/usr/bin/env node
// 校验公开 PR 模板的顶层结构。内部 review-pr Skill 有自己的私有配置，
// 本脚本不读取维护者名单、通知设置或其他内部自动化数据。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');

const read = (path) => readFileSync(path, 'utf8');

const template = read(join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'));
const requiredSections = ['这次改了什么', '怎么验证的', '风险'];
const errors = [];

/**
 * 公开贡献契约固定为三个二级标题。内部 Skill 会按目标仓库模板和自己的配置做
 * 更细的格式判定，但公开 CI 不依赖私有 Skill。
 */
const actualSections = [...template.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
for (const section of requiredSections) {
  if (!actualSections.includes(section)) {
    errors.push(`缺少二级标题「${section}」`);
  }
}
for (const section of actualSections) {
  if (!requiredSections.includes(section)) {
    errors.push(`存在未声明的二级标题「${section}」`);
  }
}

if (errors.length > 0) {
  console.error('PR 模板结构不符合公开贡献契约：');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('PR 模板结构符合公开贡献契约');
