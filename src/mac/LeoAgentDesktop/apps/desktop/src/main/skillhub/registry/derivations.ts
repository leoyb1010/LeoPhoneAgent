import os from 'node:os';
import path from 'node:path';
import { RegistryError, type SkillScope } from './types.js';

/**
 * 判断 installPath 对应的作用域。
 * 落在 path.join(os.homedir(), '.claude', 'skills', anything) 下 → 'global'
 * 否则 → 'project'
 * 跨平台:对入参 path.normalize 后再判断;Windows 用 path.sep 比较
 */
export function deriveScope(installPath: string): SkillScope {
  const norm = path.normalize(installPath);
  const globalBases = [
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.codex', 'skills'),
  ];
  for (const base of globalBases) {
    if (norm.startsWith(base + path.sep) || norm === base) {
      return 'global';
    }
  }
  return 'project';
}

/**
 * 从 installPath 推导项目工作目录（砍掉尾部 /.claude/skills/<skillName>）。
 * global scope → null
 * project scope → installPath 向上三级即为项目根目录
 */
export function deriveProjectWorkingDir(installPath: string): string | null {
  const scope = deriveScope(installPath);
  if (scope === 'global') return null;

  // installPath = <projectRoot>/.claude/skills/<skillName>
  // dirname 三次:
  //   1) <projectRoot>/.claude/skills
  //   2) <projectRoot>/.claude
  //   3) <projectRoot>
  const norm = path.normalize(installPath);
  return path.dirname(path.dirname(path.dirname(norm)));
}

/**
 * 校验 skillName 格式：^[a-z0-9-]{1,200}$
 * 不通过抛 RegistryError('REGISTRY_INVALID_NAME')
 * 不做 silent sanitize（避免不同 name 落到同一文件）
 */
export function sanitizeSkillName(name: string): string {
  if (!/^[a-z0-9-]{1,200}$/.test(name)) {
    throw new RegistryError(
      'REGISTRY_INVALID_NAME',
      `skill name "${name}" 不符合 ^[a-z0-9-]{1,200}$ 格式`,
    );
  }
  return name;
}
