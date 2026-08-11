import React from 'react';

interface FileListItem {
  path: string;
  onClick?: () => void;
}

interface FileListContentProps {
  files: string[] | FileListItem[];
  onFileClick?: (filePath: string) => void;
  title?: string;
}

/**
 * Renders a compact comma-separated list of clickable file names
 * Used by: Grep/Glob results
 */
export const FileListContent: React.FC<FileListContentProps> = ({
  files,
  onFileClick,
  title
}) => {
  return (
    <div>
      {title && (
        <div className="mb-1 text-[11px] text-muted-foreground dark:text-muted-foreground">
          {title}
        </div>
      )}
      <div className="flex max-h-48 flex-wrap gap-x-1 gap-y-0.5 overflow-y-auto">
        {files.map((file, index) => {
          const filePath = typeof file === 'string' ? file : file.path;
          const fileName = filePath.split('/').pop() || filePath;
          const handleClick = typeof file === 'string'
            ? () => onFileClick?.(file)
            : file.onClick;

          return (
            <span key={index} className="inline-flex items-center">
              <button
                onClick={handleClick}
                className="font-mono text-[11px] text-info transition-colors hover:text-info hover:underline dark:text-info dark:hover:text-info"
                title={filePath}
              >
                {fileName}
              </button>
              {index < files.length - 1 && (
                <span className="ml-1 text-[10px] text-muted-foreground dark:text-muted-foreground">,</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
};
