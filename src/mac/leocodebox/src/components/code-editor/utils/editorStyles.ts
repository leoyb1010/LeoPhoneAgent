export const getEditorLoadingStyles = (_isDarkMode: boolean) => {
  return `
    .code-editor-loading {
      background-color: hsl(var(--background)) !important;
    }

    .code-editor-loading:hover {
      background-color: hsl(var(--background)) !important;
    }
  `;
};

export const getEditorStyles = (_isDarkMode: boolean) => {
  return `
    .cm-deletedChunk {
      background-color: hsl(var(--destructive) / 0.15) !important;
      border-left: 3px solid hsl(var(--destructive) / 0.65) !important;
      padding-left: 4px !important;
    }

    .cm-insertedChunk {
      background-color: hsl(var(--success) / 0.15) !important;
      border-left: 3px solid hsl(var(--success) / 0.65) !important;
      padding-left: 4px !important;
    }

    .cm-editor.cm-merge-b .cm-changedText {
      background: hsl(var(--success) / 0.35) !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-editor .cm-deletedChunk .cm-changedText {
      background: hsl(var(--destructive) / 0.35) !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-gutter.cm-gutter-minimap {
      background-color: hsl(var(--muted));
    }

    .cm-editor-toolbar-panel {
      padding: 4px 10px;
      background-color: hsl(var(--card));
      border-bottom: 1px solid hsl(var(--border));
      color: hsl(var(--foreground));
      font-size: 12px;
    }

    .cm-diff-nav-btn,
    .cm-toolbar-btn {
      padding: 3px;
      background: transparent;
      border: none;
      cursor: pointer;
      border-radius: var(--radius-control);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      transition: background-color var(--motion-base);
    }

    .cm-diff-nav-btn:hover,
    .cm-toolbar-btn:hover {
      background-color: hsl(var(--accent));
    }

    .cm-diff-nav-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;
};
