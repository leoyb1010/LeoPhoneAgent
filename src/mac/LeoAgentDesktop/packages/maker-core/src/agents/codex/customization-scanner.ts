/**
 * Codex 文件系统 customization scanner。
 *
 * 扫描路径:
 *   ~/.agents/skills/{name}/SKILL.md      → kind=skill, scope=user (跨引擎共享)
 *   ~/.codex/skills/{name}/SKILL.md       → kind=skill, scope=user
 *   {workingDir}/.codex/skills/{name}/... → kind=skill, scope=repo
 *
 * 仅用于 SkillHub 管理页面（文件系统发现）。
 * 对话运行时的技能列表仍走 RPC (listAgentSkills)。
 */

import os from 'node:os';
import path from 'node:path';

import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import { scanCustomizationSources, type SourceDef } from '../shared/customization-scanner.js';

function buildCodexSources(workingDirs: string[]): SourceDef[] {
  const home = os.homedir();
  const sources: SourceDef[] = [
    { engine: 'codex', kind: 'skill', scope: 'user', dir: path.join(home, '.agents', 'skills') },
    { engine: 'codex', kind: 'skill', scope: 'user', dir: path.join(home, '.codex', 'skills') },
  ];
  for (const wd of workingDirs) {
    if (!wd || !path.isAbsolute(wd)) continue;
    sources.push(
      { engine: 'codex', kind: 'skill', scope: 'repo', dir: path.join(wd, '.agents', 'skills'), workingDir: wd },
      { engine: 'codex', kind: 'skill', scope: 'repo', dir: path.join(wd, '.codex', 'skills'), workingDir: wd },
    );
  }
  return sources;
}

export async function scanCodexCustomizations(
  opts: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes('skill')) {
    return { items: [], errors: [] };
  }

  const workingDirs = opts.workingDirs ?? [];
  const sources = buildCodexSources(workingDirs);
  const result = scanCustomizationSources(sources, null);

  result.items.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.name.localeCompare(b.name);
  });

  return result;
}
