import { z } from 'zod';

import {
  LANGUAGE,
  filterGitIgnoredUris,
  groupLocationsByFile,
  relativeFilePath,
  resolveFileInWorkdir,
  toLspPosition,
} from '../_shared.js';
import type { LspToolRegistry } from '../registry.js';

const NO_REFERENCES =
  'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.';

export function registerFindReferencesTool(registry: LspToolRegistry): void {
  registry.register({
    name: 'lsp_find_references',
    description:
      'Find exact TypeScript references at a concrete file position. Use this for refactors after locating the symbol in a file.',
    inputShape: {
      file: z.string().min(1).describe('File path relative to the current workdir.'),
      line: z.number().int().min(1).describe('1-based line number, as shown in editors.'),
      character: z.number().int().min(1).describe('1-based character offset, as shown in editors.'),
      includeDeclaration: z.boolean().optional().describe('Include the declaration location. Default false.'),
    },
    handler: async ({ file, line, character, includeDeclaration }) => {
      const proc = await registry.deps.pool.getOrSpawn(registry.deps.workdir, LANGUAGE);
      const absPath = resolveFileInWorkdir(registry.deps.workdir, file);
      const uri = await proc.ensureFileOpen(absPath);
      const refs = ((await proc.references(uri, toLspPosition(line, character), includeDeclaration ?? false)) ?? []).filter(
        (ref) => ref && ref.uri,
      );
      if (refs.length === 0) return NO_REFERENCES;

      const ignored = await filterGitIgnoredUris(
        registry.deps.workdir,
        refs.map((ref) => ref.uri),
      );
      const visible = refs.filter((ref) => !ignored.has(ref.uri));
      if (visible.length === 0) return NO_REFERENCES;

      if (visible.length === 1) {
        const ref = visible[0];
        const rel = relativeFilePath(ref.uri, registry.deps.workdir);
        const l = ref.range.start.line + 1;
        const c = ref.range.start.character + 1;
        return `Found 1 reference:\n  ${rel}:${l}:${c}`;
      }

      const groups = groupLocationsByFile(visible, registry.deps.workdir);
      const lines: string[] = [`Found ${visible.length} references across ${groups.size} files:`];
      for (const [filePath, items] of groups) {
        lines.push(`\n${filePath}:`);
        for (const ref of items) {
          const l = ref.range.start.line + 1;
          const c = ref.range.start.character + 1;
          lines.push(`  Line ${l}:${c}`);
        }
      }
      return lines.join('\n');
    },
  });
}
