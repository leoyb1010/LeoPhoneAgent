import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * grok reads skills from ~/.grok/skills (user) and .grok/skills in the project.
 */
export class GrokSkillsProvider extends SkillsProvider {
  constructor() {
    super('grok');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      { scope: 'project', rootDir: path.join(workspacePath, '.grok', 'skills'), commandPrefix: '/' },
      { scope: 'user', rootDir: path.join(os.homedir(), '.grok', 'skills'), commandPrefix: '/' },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return { scope: 'user', rootDir: path.join(os.homedir(), '.grok', 'skills'), commandPrefix: '/' };
  }
}
