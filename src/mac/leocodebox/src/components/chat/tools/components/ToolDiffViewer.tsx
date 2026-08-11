import React, { useMemo } from 'react';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface ToolDiffViewerProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileClick?: () => void;
  badge?: string;
  badgeColor?: 'gray' | 'green';
}

/**
 * Compact diff viewer — VS Code-style
 */
export const ToolDiffViewer: React.FC<ToolDiffViewerProps> = ({
  oldContent,
  newContent,
  filePath,
  createDiff,
  onFileClick,
  badge = 'Diff',
  badgeColor = 'gray'
}) => {
  const badgeClasses = badgeColor === 'green'
    ? 'bg-success dark:bg-success/30 text-success dark:text-success'
    : 'bg-muted dark:bg-muted text-muted-foreground dark:text-muted-foreground';

  const diffLines = useMemo(
    () => {
      if (oldContent === undefined || newContent === undefined) {
        return [];
      }
      return createDiff(oldContent, newContent)
    },
    [createDiff, oldContent, newContent]
  );

  return (
    <div className="overflow-hidden rounded-md border border-border dark:border-border">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-muted/80 px-2.5 py-1 dark:border-border dark:bg-muted/40">
        {onFileClick ? (
          <button
            onClick={onFileClick}
            className="cursor-pointer truncate font-mono text-[11px] text-info transition-colors hover:text-info dark:text-info dark:hover:text-info"
          >
            {filePath}
          </button>
        ) : (
          <span className="truncate font-mono text-[11px] text-muted-foreground dark:text-muted-foreground">
            {filePath}
          </span>
        )}
        <span className={`rounded-md px-1.5 py-px text-[10px] font-medium ${badgeClasses} ml-2 flex-shrink-0`}>
          {badge}
        </span>
      </div>

      {/* Diff lines */}
      <div className="font-mono text-[11px] leading-[18px]">
        {diffLines.map((diffLine, i) => (
          <div key={i} className="flex">
            <span
              className={`w-6 flex-shrink-0 select-none text-center ${
                diffLine.type === 'removed'
                  ? 'bg-destructive text-destructive dark:bg-destructive/30 dark:text-destructive'
                  : 'bg-success/15 text-success dark:bg-success/25 dark:text-success'
              }`}
            >
              {diffLine.type === 'removed' ? '-' : '+'}
            </span>
            <span
              className={`flex-1 whitespace-pre-wrap px-2 ${
                diffLine.type === 'removed'
                  ? 'bg-destructive/50 text-destructive dark:bg-destructive/20 dark:text-destructive'
                  : 'bg-success/50 text-success dark:bg-success/20 dark:text-success'
              }`}
            >
              {diffLine.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
