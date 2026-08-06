/**
 * serializeEnvBlock — gatekeeper for the env vars we ferry to the remote
 * agent via stdin.
 *
 * Why this lives in its own module (rather than next to the IPC handler):
 *   - Pure function with zero runtime deps → testable without pulling in
 *     Electron's `app.getPath` chain that the IPC handler module needs.
 *   - Single responsibility: validate + format. Keeps the IPC layer thin.
 *
 * Protocol contract:
 *   - Output lines have no trailing newline (caller adds the empty-line
 *     separator before the prompt body).
 *   - Values must NOT contain CR/LF; if they did, a leaked newline would
 *     terminate the env block early on the remote side and bleed bytes
 *     into the prompt — leaking part of an API key into the model input.
 *   - Keys must match POSIX env var rules (`[A-Z_][A-Z0-9_]*`); anything
 *     else would either be ignored by `export` or pass through with
 *     surprising shell semantics.
 *
 * API keys and base URLs never contain newlines, so the validation here
 * is defence-in-depth, not pragmatism.
 */
export function serializeEnvBlock(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n]/.test(v)) {
      throw new Error(`env var ${k} contains a newline; cannot ferry via stdin`);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
      throw new Error(`env var name ${k} is not POSIX-valid`);
    }
    lines.push(`${k}=${v}`);
  }
  return lines.join('\n');
}
