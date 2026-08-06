/**
 * ThinkingText
 * ---------------------------------------------------------------------------
 * Lightweight inline presentation for model reasoning. Codex commonly wraps
 * short reasoning updates in Markdown strong markers; rendering those markers
 * literally is noisy, while the full chat Markdown pipeline is too heavy and
 * allows block layouts that do not belong inside compact activity rows.
 *
 * Supported syntax is intentionally narrow and deterministic:
 *   - paired `**text**` → medium-weight text (500, per docs/design-rules/cindy-design-system.md);
 *   - paired backtick runs → inline monospace text;
 *   - malformed / unmatched delimiters remain literal text.
 *
 * Lists, headings, links, images, and HTML are never interpreted here.
 */

import { Fragment, memo, useMemo } from 'react';
import { tokenizeThinkingText } from '@cindy/maker-shared/thinking-text';

export { tokenizeThinkingText } from '@cindy/maker-shared/thinking-text';
export type { ThinkingTextToken } from '@cindy/maker-shared/thinking-text';

/** Shared compact renderer for live, expanded, and standalone thinking views. */
export const ThinkingText = memo(function ThinkingText({ content }: { content: string }) {
  const tokens = useMemo(() => tokenizeThinkingText(content), [content]);
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === 'strong') {
          return (
            <span key={`strong-${index}`} data-thinking-markup="strong" className="font-medium">
              {token.value}
            </span>
          );
        }
        if (token.kind === 'code') {
          return (
            <code
              key={`code-${index}`}
              data-thinking-markup="code"
              className="font-mono not-italic"
            >
              {token.value}
            </code>
          );
        }
        return <Fragment key={`text-${index}`}>{token.value}</Fragment>;
      })}
    </>
  );
});
