export type PlaintextEditorChrome = 'code' | 'markdown' | 'plain';

export function getPlaintextEditorChrome(language: string | undefined): PlaintextEditorChrome {
  const normalizedLanguage = language?.toLowerCase();
  const isMarkdown = normalizedLanguage === 'markdown' || normalizedLanguage === 'md';
  if (isMarkdown) return 'markdown';
  if (normalizedLanguage) return 'code';
  return 'plain';
}
