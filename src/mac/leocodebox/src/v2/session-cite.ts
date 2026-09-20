/** 输入栏里提到的源文件，发出去要带上正文，不只是路径。 */

const CITE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|go|rs|swift|kt|java|yml|yaml|toml|sh|sql)$/i;

export function citePathsInPrompt(prompt?: string | null): string[] {
  const text = String(prompt ?? '');
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s`'"(])((?:~\/|\/|\.\.?\/)?(?:[^\s`'")]+\/)*[^\s`'")]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|go|rs|swift|kt|java|yml|yaml|toml|sh|sql))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const raw = String(match[1] ?? '').replace(/[.,;:]+$/, '');
    if (!CITE_EXT.test(raw) || seen.has(raw)) continue;
    if (raw.startsWith('http://') || raw.startsWith('https://')) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}

export function canCiteSessionFiles(input: { machine?: string | null; prompt?: string | null }): boolean {
  return input.machine === 'local' && citePathsInPrompt(input.prompt).length > 0;
}
