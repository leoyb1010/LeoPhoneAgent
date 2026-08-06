export function mergeRecoveredTranscript(prefix: string, transcript: string): string {
  const normalizedPrefix = prefix.trim();
  const normalizedTranscript = transcript.trim();
  if (!normalizedPrefix) return normalizedTranscript;
  if (!normalizedTranscript) return normalizedPrefix;
  if (normalizedTranscript.startsWith(normalizedPrefix)) return normalizedTranscript;

  const maxOverlap = Math.min(normalizedPrefix.length, normalizedTranscript.length);
  for (let length = maxOverlap; length >= 2; length -= 1) {
    if (normalizedPrefix.endsWith(normalizedTranscript.slice(0, length))) {
      return normalizedPrefix + normalizedTranscript.slice(length);
    }
  }

  const left = normalizedPrefix.at(-1) ?? '';
  const right = normalizedTranscript.at(0) ?? '';
  if (/[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right)) {
    return `${normalizedPrefix} ${normalizedTranscript}`;
  }
  return normalizedPrefix + normalizedTranscript;
}
