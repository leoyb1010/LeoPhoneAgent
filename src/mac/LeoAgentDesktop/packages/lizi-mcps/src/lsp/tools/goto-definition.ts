import { z } from 'zod';

import {
  LANGUAGE,
  filterGitIgnoredUris,
  formatLocationText,
  normalizeLocations,
  resolveFileInWorkdir,
  toLspPosition,
} from '../_shared.js';
import type { LspToolRegistry } from '../registry.js';

const NO_DEFINITION =
  'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.';

export function registerGotoDefinitionTool(registry: LspToolRegistry): void {
  registry.register({
    name: 'lsp_goto_definition',
    description:
      'Go to the TypeScript definition at a concrete file position. Position uses editor-visible 1-based line and 1-based character.',
    inputShape: {
      file: z.string().min(1).describe('File path relative to the current workdir.'),
      line: z.number().int().min(1).describe('1-based line number, as shown in editors.'),
      character: z.number().int().min(1).describe('1-based character offset, as shown in editors.'),
    },
    handler: async ({ file, line, character }) => {
      const proc = await registry.deps.pool.getOrSpawn(registry.deps.workdir, LANGUAGE);
      const absPath = resolveFileInWorkdir(registry.deps.workdir, file);
      const uri = await proc.ensureFileOpen(absPath);
      const raw = await proc.definition(uri, toLspPosition(line, character));
      const locations = normalizeLocations(raw).filter((loc) => loc && loc.uri);
      if (locations.length === 0) return NO_DEFINITION;

      const ignored = await filterGitIgnoredUris(
        registry.deps.workdir,
        locations.map((loc) => loc.uri),
      );
      const visible = locations.filter((loc) => !ignored.has(loc.uri));
      if (visible.length === 0) return NO_DEFINITION;

      if (visible.length === 1) {
        return `Defined in ${formatLocationText(visible[0], registry.deps.workdir)}`;
      }
      const body = visible
        .map((loc) => `  ${formatLocationText(loc, registry.deps.workdir)}`)
        .join('\n');
      return `Found ${visible.length} definitions:\n${body}`;
    },
  });
}
