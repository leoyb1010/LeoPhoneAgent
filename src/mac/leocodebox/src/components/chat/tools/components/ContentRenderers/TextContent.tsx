import React from 'react';

interface TextContentProps {
  content: string;
  format?: 'plain' | 'json' | 'code';
  className?: string;
}

/**
 * Renders plain text, JSON, or code content
 * Used by: Raw parameters, generic text results, JSON responses
 */
export const TextContent: React.FC<TextContentProps> = ({
  content,
  format = 'plain',
  className = ''
}) => {
  if (format === 'json') {
    let formattedJson = content;
    try {
      const parsed = JSON.parse(content);
      formattedJson = JSON.stringify(parsed, null, 2);
    } catch (e) {
      // If parsing fails, use original content
      console.warn('Failed to parse JSON content:', e);
    }

    return (
      <pre className={`mt-1 overflow-x-auto rounded-md bg-muted p-2.5 font-mono text-xs text-muted-foreground dark:bg-muted ${className}`}>
        {formattedJson}
      </pre>
    );
  }

  if (format === 'code') {
    return (
      <pre className={`mt-1 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-border bg-muted p-2 font-mono text-xs text-muted-foreground dark:border-border dark:bg-muted/50 dark:text-muted-foreground ${className}`}>
        {content}
      </pre>
    );
  }

  // Plain text
  return (
    <div className={`mt-1 whitespace-pre-wrap text-sm text-muted-foreground dark:text-muted-foreground ${className}`}>
      {content}
    </div>
  );
};
