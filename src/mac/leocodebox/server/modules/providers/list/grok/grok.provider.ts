import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { GrokProviderAuth } from '@/modules/providers/list/grok/grok-auth.provider.js';
import { GrokProviderModels } from '@/modules/providers/list/grok/grok-models.provider.js';
import { GrokMcpProvider } from '@/modules/providers/list/grok/grok-mcp.provider.js';
import { GrokSessionSynchronizer } from '@/modules/providers/list/grok/grok-session-synchronizer.provider.js';
import { GrokSessionsProvider } from '@/modules/providers/list/grok/grok-sessions.provider.js';
import { GrokSkillsProvider } from '@/modules/providers/list/grok/grok-skills.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

export class GrokProvider extends AbstractProvider {
  readonly models: IProviderModels = new GrokProviderModels();
  readonly mcp: IProviderMcp = new GrokMcpProvider();
  readonly auth: IProviderAuth = new GrokProviderAuth();
  readonly skills: IProviderSkills = new GrokSkillsProvider();
  readonly sessions: IProviderSessions = new GrokSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new GrokSessionSynchronizer();

  constructor() {
    super('grok');
  }
}
