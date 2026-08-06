/**
 * File-tree row icon picker.
 *
 * Lucide icons we have available (verified imports in the bundle):
 *   FileText / FileCode / FileImage / File (generic) / Folder / FolderOpen
 *
 * The mapping is intentionally small — most "code" files share `FileCode`,
 * most "config" files do too. Only Markdown gets `FileText`. Images get
 * `FileImage`. Everything else falls back to generic `File`.
 *
 * Extension list aligns with lib/textPreview.EXT_TO_LANG so the tree icon
 * matches what the body viewer can render.
 */

import {
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs',
  'php', 'dart', 'lua',
  'sh', 'bash', 'zsh', 'ps1',
  'yaml', 'yml', 'toml', 'ini', 'json', 'jsonc',
  'xml', 'html', 'htm', 'svg', 'vue', 'svelte',
  'css', 'scss', 'sass', 'less',
  'sql', 'graphql', 'gql',
  'diff', 'patch',
  'csproj', 'sln', 'shader', 'unityproj', 'asmdef',
]);

const MD_EXTS = new Set(['md', 'mdx', 'markdown', 'mdown', 'mkdn', 'mkd']);

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tga', 'tiff',
]);

/**
 * Pick an icon for a file row. Folder rows have their own picker (`pickFolderIcon`);
 * this is files-only.
 */
export function pickFileIcon(name: string): LucideIcon {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return File;
  const ext = name.slice(dot + 1).toLowerCase();
  if (MD_EXTS.has(ext)) return FileText;
  if (CODE_EXTS.has(ext)) return FileCode;
  if (IMAGE_EXTS.has(ext)) return FileImage;
  return File;
}

export function pickFolderIcon(expanded: boolean): LucideIcon {
  return expanded ? FolderOpen : Folder;
}
