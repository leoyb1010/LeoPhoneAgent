const REDACTED = '[REDACTED]';

export function redactMobileVoiceCredentialText(
  value: unknown,
  credential: { proxyApiKey?: unknown } | string | null | undefined,
): string {
  let text = value instanceof Error ? value.message : String(value);
  const secret = typeof credential === 'string' ? credential : credential?.proxyApiKey;
  if (typeof secret !== 'string' || !secret) return text;
  for (const candidate of redactionCandidates(secret)) {
    text = text.split(candidate).join(REDACTED);
  }
  return text;
}

export function redactMobileVoiceCredentialValue<T extends { proxyApiKey?: unknown }>(
  credential: T,
): Omit<T, 'proxyApiKey'> & { proxyApiKey: string } {
  return { ...credential, proxyApiKey: REDACTED };
}

function redactionCandidates(secret: string): string[] {
  const candidates = [
    secret,
    encodeURIComponent(secret),
    encodeURI(secret),
  ];
  return candidates.filter((candidate, index) =>
    candidate.length > 0 && candidates.indexOf(candidate) === index,
  );
}
