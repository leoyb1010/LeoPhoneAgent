import { useMemo } from 'react';

type PrdEditorFooterProps = {
  content: string;
};

type ContentStats = {
  lines: number;
  characters: number;
  words: number;
};

function getContentStats(content: string): ContentStats {
  return {
    lines: content.split('\n').length,
    characters: content.length,
    words: content.split(/\s+/).filter(Boolean).length,
  };
}

export default function PrdEditorFooter({ content }: PrdEditorFooterProps) {
  const stats = useMemo(() => getContentStats(content), [content]);

  return (
    <div className="flex flex-shrink-0 items-center justify-between border-t border-border bg-muted p-3 dark:border-border dark:bg-muted">
      <div className="flex items-center gap-4 text-sm text-muted-foreground dark:text-muted-foreground">
        <span>Lines: {stats.lines}</span>
        <span>Characters: {stats.characters}</span>
        <span>Words: {stats.words}</span>
        <span>Format: Markdown</span>
      </div>

      <div className="text-sm text-muted-foreground dark:text-muted-foreground">Press Ctrl+S to save and Esc to close</div>
    </div>
  );
}
