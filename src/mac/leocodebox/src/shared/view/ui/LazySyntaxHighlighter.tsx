import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

type SyntaxTheme = Record<string, CSSProperties>;

type LazySyntaxHighlighterProps = {
  language: string;
  raw: string;
  isDarkMode: boolean;
};

const themeCache = new Map<'dark' | 'light', SyntaxTheme>();

export default function LazySyntaxHighlighter({ language, raw, isDarkMode }: LazySyntaxHighlighterProps) {
  const mode = isDarkMode ? 'dark' : 'light';
  const [theme, setTheme] = useState<SyntaxTheme | undefined>(() => themeCache.get(mode));

  useEffect(() => {
    let cancelled = false;
    const cached = themeCache.get(mode);
    if (cached) {
      setTheme(cached);
      return undefined;
    }

    const request = mode === 'dark'
      ? import('react-syntax-highlighter/dist/esm/styles/prism/one-dark')
      : import('react-syntax-highlighter/dist/esm/styles/prism/one-light');
    void request.then(({ default: loadedTheme }) => {
      const normalized = loadedTheme as SyntaxTheme;
      themeCache.set(mode, normalized);
      if (!cancelled) setTheme(normalized);
    });
    return () => { cancelled = true; };
  }, [mode]);

  return (
    <SyntaxHighlighter
      language={language}
      style={theme}
      customStyle={{
        margin: 0,
        borderRadius: 'var(--radius-card, 0.75rem)',
        fontSize: '0.875rem',
        padding: language !== 'text' ? '2rem 1rem 1rem' : '1rem',
        ...(isDarkMode ? {} : { background: 'hsl(var(--muted))' }),
      }}
      codeTagProps={{
        style: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          ...(isDarkMode ? {} : { background: 'transparent' }),
        },
      }}
    >
      {raw}
    </SyntaxHighlighter>
  );
}
