type ErrorLike = {
  code?: unknown;
  path?: unknown;
  message?: unknown;
};

export type ProviderErrorClassification = {
  code: 'PROVIDER_AUTH_EXPIRED' | 'PROVIDER_NOT_AUTHENTICATED' | 'PROVIDER_AUTH_INVALID' | 'PROVIDER_CLI_NOT_FOUND';
  rawError: string;
};

function readErrorLike(error: unknown): ErrorLike | null {
  return typeof error === 'object' && error ? error as ErrorLike : null;
}

function readErrorMessage(error: unknown): string {
  const value = readErrorLike(error);
  return String(value?.message || error || '');
}

export function isMissingCliExecutableError(error: unknown, command: string): boolean {
  const value = readErrorLike(error);
  const code = value?.code ?? null;
  const executablePath = value?.path ?? null;
  if (code === 'ENOENT' && (!executablePath || String(executablePath).includes(command))) {
    return true;
  }

  const message = readErrorMessage(error).toLowerCase();
  const normalizedCommand = String(command || '').toLowerCase();
  if (!normalizedCommand || !message.includes(normalizedCommand)) return false;

  return message.includes('enoent')
    || message.includes('executable not found')
    || message.includes('failed to spawn')
    || message.includes('no such file or directory');
}

const LOGIN_PATTERNS = [
  /not logged in/i,
  /not authenticated/i,
  /authentication required/i,
  /login required/i,
  /please run \/login/i,
  /no valid tokens/i,
];

export function classifyProviderError(error: unknown): ProviderErrorClassification | null {
  const message = readErrorMessage(error).trim();
  if (!message) return null;

  if (/login.*expired|credentials?.*expired|token.*expired/i.test(message)) {
    return { code: 'PROVIDER_AUTH_EXPIRED', rawError: message };
  }
  if (LOGIN_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: 'PROVIDER_NOT_AUTHENTICATED', rawError: message };
  }
  if (/credentials?.*(?:unusable|invalid)|invalid api key|unauthorized|\b401\b/i.test(message)) {
    return { code: 'PROVIDER_AUTH_INVALID', rawError: message };
  }
  const knownCliMissing = ([
    ['claude', /\bclaude(?: code)?\b/i],
    ['codex', /\bcodex\b/i],
    ['cursor-agent', /\bcursor(?:-agent| agent)?\b/i],
    ['opencode', /\bopencode\b/i],
  ] as Array<[string, RegExp]>).some(([command, providerPattern]) => (
    providerPattern.test(message)
    && (
      isMissingCliExecutableError(error, String(command))
      || /not installed|command not found|executable not found/i.test(message)
    )
  ));
  if (knownCliMissing) {
    return { code: 'PROVIDER_CLI_NOT_FOUND', rawError: message };
  }
  return null;
}

export function isStandaloneProviderAuthenticationFailure(value: unknown): boolean {
  const message = String(value || '').trim();
  return message.length > 0
    && message.length <= 240
    && /^(?:error:\s*)?(?:not logged in|not authenticated|authentication required|login required|please run \/login)(?:\b|\s|[.·:])/i.test(message);
}
