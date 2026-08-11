import type {
  LLMProvider,
  ProviderManifest,
} from '@/shared/types.js';
export { PROVIDER_TEMPLATES } from '../../shared/provider-templates.js';

const supportedCapabilities = {
  auth: 'supported',
  models: 'supported',
  sessions: 'supported',
  sessionSync: 'supported',
  mcp: 'supported',
  skills: 'supported',
  chat: 'supported',
  configSwitch: 'supported',
} as const;

export const PROVIDER_MANIFESTS = [
  {
    id: 'claude', displayName: 'Claude Code', vendor: 'Anthropic', visibility: 'public', verification: 'verified', order: 10,
    runtimeProvider: 'claude', configTarget: 'claude', cliTool: 'claude', docsUrl: 'https://code.claude.com/docs/',
    capabilities: { ...supportedCapabilities, cliInstall: 'supported', cliUpdate: 'supported' },
  },
  {
    id: 'codex', displayName: 'Codex', vendor: 'OpenAI', visibility: 'public', verification: 'verified', order: 20,
    runtimeProvider: 'codex', configTarget: 'codex', cliTool: 'codex', docsUrl: 'https://github.com/openai/codex',
    capabilities: { ...supportedCapabilities, cliInstall: 'supported', cliUpdate: 'supported' },
  },
  {
    id: 'cursor', displayName: 'Cursor Agent', vendor: 'Cursor', visibility: 'public', verification: 'verified', order: 30,
    runtimeProvider: 'cursor', configTarget: 'cursor', cliTool: 'cursor', docsUrl: 'https://cursor.com/',
    capabilities: { ...supportedCapabilities, cliInstall: 'unsupported', cliUpdate: 'supported' },
  },
  {
    id: 'opencode', displayName: 'OpenCode', vendor: 'OpenCode', visibility: 'public', verification: 'verified', order: 40,
    runtimeProvider: 'opencode', configTarget: 'opencode', cliTool: 'opencode', docsUrl: 'https://opencode.ai/',
    capabilities: { ...supportedCapabilities, cliInstall: 'supported', cliUpdate: 'supported' },
  },
  {
    id: 'gemini', displayName: 'Gemini CLI', vendor: 'Google', visibility: 'public', verification: 'preview', order: 50,
    configTarget: 'gemini', cliTool: 'gemini', docsUrl: 'https://github.com/google-gemini/gemini-cli',
    capabilities: {
      chat: 'unverified', auth: 'unverified', models: 'supported', sessions: 'unverified',
      sessionSync: 'unverified', mcp: 'unverified', skills: 'unverified', configSwitch: 'supported',
      cliInstall: 'supported', cliUpdate: 'supported',
    },
  },
  {
    id: 'grok', displayName: 'Grok Build', vendor: 'xAI', visibility: 'public', verification: 'beta', order: 60,
    runtimeProvider: 'grok', configTarget: 'codex', cliTool: 'grok', docsUrl: 'https://docs.x.ai/build',
    capabilities: {
      chat: 'supported', auth: 'supported', models: 'supported', sessions: 'supported',
      sessionSync: 'unsupported', mcp: 'unsupported', skills: 'supported', configSwitch: 'supported',
      cliInstall: 'unsupported', cliUpdate: 'supported',
    },
  },
  {
    id: 'antigravity', displayName: 'Antigravity', vendor: 'Google', visibility: 'experimental', verification: 'unverified', order: 70,
    capabilities: {
      chat: 'unverified', auth: 'unverified', models: 'unverified', sessions: 'unverified',
      sessionSync: 'unverified', mcp: 'unverified', skills: 'unverified', configSwitch: 'unverified',
      cliInstall: 'unverified', cliUpdate: 'unverified',
    },
  },
  {
    id: 'openclaw', displayName: 'OpenClaw', vendor: 'OpenClaw', visibility: 'experimental', verification: 'unverified', order: 80,
    capabilities: {
      chat: 'unverified', auth: 'unverified', models: 'unverified', sessions: 'unverified',
      sessionSync: 'unverified', mcp: 'unverified', skills: 'unverified', configSwitch: 'unverified',
      cliInstall: 'unverified', cliUpdate: 'unverified',
    },
  },
] satisfies ProviderManifest[];

export const CHAT_PROVIDER_IDS = PROVIDER_MANIFESTS
  .filter((manifest) => manifest.capabilities.chat === 'supported')
  .map((manifest) => manifest.id) as LLMProvider[];
