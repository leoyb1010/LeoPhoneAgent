import type { LLMProvider } from '../../types/app';

export type ProviderAuthStatus = {
  installed: boolean | null;
  version: string | null;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
};

export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

export const CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'grok'];

export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude: '/api/providers/claude/auth/status',
  cursor: '/api/providers/cursor/auth/status',
  codex: '/api/providers/codex/auth/status',
  opencode: '/api/providers/opencode/auth/status',
  grok: '/api/providers/grok/auth/status',
};

export const createInitialProviderAuthStatusMap = (loading = true): ProviderAuthStatusMap => ({
  claude: { installed: null, version: null, authenticated: false, email: null, method: null, error: null, loading },
  cursor: { installed: null, version: null, authenticated: false, email: null, method: null, error: null, loading },
  codex: { installed: null, version: null, authenticated: false, email: null, method: null, error: null, loading },
  opencode: { installed: null, version: null, authenticated: false, email: null, method: null, error: null, loading },
  grok: { installed: null, version: null, authenticated: false, email: null, method: null, error: null, loading },
});
