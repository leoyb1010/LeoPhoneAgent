import { lazy, Suspense, useState } from 'react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { copyTextToClipboard } from '../../../../../utils/clipboard';
import { useTheme } from '../../../../../contexts/ThemeContext';

const LazySyntaxHighlighter = lazy(() => import('../../../../../shared/view/ui/LazySyntaxHighlighter'));
const MAX_HIGHLIGHT_CHARS = 50_000;

type MarkdownCodeBlockProps = {
  inline?: boolean;
  node?: unknown;
} & ComponentProps<'code'>;

export default function MarkdownCodeBlock({
  inline,
  className,
  children,
  node: _node,
  ...props
}: MarkdownCodeBlockProps) {
  const { isDarkMode } = useTheme();
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const rawContent = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(rawContent);
  const shouldRenderInline = inline || !looksMultiline;

  if (shouldRenderInline) {
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-muted-foreground dark:border-border dark:bg-muted/60 dark:text-muted-foreground ${className || ''}`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const languageMatch = /language-(\w+)/.exec(className || '');
  const language = languageMatch ? languageMatch[1] : 'text';

  return (
    <div className="group relative my-2">
      {language !== 'text' && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-muted-foreground">{language}</div>
      )}

      <button
        type="button"
        onClick={() =>
          copyTextToClipboard(rawContent).then((success) => {
            if (success) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          })}
        className="absolute right-2 top-2 z-10 rounded-md border border-border bg-card/90 px-2 py-1 text-xs text-foreground/80 opacity-0 transition-opacity hover:bg-muted focus:opacity-100 group-hover:opacity-100"
        aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
      >
        {copied ? t('codeBlock.copied') : t('codeBlock.copy')}
      </button>

      {language !== 'text' && rawContent.length <= MAX_HIGHLIGHT_CHARS ? (
        <Suspense fallback={<pre className="m-0 overflow-x-auto rounded-xl bg-muted p-4 font-mono text-sm"><code>{rawContent}</code></pre>}>
          <LazySyntaxHighlighter language={language} raw={rawContent} isDarkMode={isDarkMode} />
        </Suspense>
      ) : (
        <pre className="m-0 overflow-x-auto rounded-xl bg-muted p-4 font-mono text-sm"><code>{rawContent}</code></pre>
      )}
    </div>
  );
}
