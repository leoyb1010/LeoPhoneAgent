import { z } from 'zod';

import {
  LANGUAGE,
  hoverContentsToText,
  resolveFileInWorkdir,
  toLspPosition,
} from '../_shared.js';
import type { LspToolRegistry } from '../registry.js';

const NO_HOVER =
  'No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.';

export function registerHoverTool(registry: LspToolRegistry): void {
  registry.register({
    name: 'lsp_hover',
    description:
      'Return TypeScript hover/type information at a concrete file position.',
    inputShape: {
      file: z.string().min(1).describe('File path relative to the current workdir.'),
      line: z.number().int().min(1).describe('1-based line number, as shown in editors.'),
      character: z.number().int().min(1).describe('1-based character offset, as shown in editors.'),
    },
    handler: async ({ file, line, character }) => {
      const proc = await registry.deps.pool.getOrSpawn(registry.deps.workdir, LANGUAGE);
      const absPath = resolveFileInWorkdir(registry.deps.workdir, file);
      const uri = await proc.ensureFileOpen(absPath);
      const hover = await proc.hover(uri, toLspPosition(line, character));
      if (!hover) return NO_HOVER;

      const text = hoverContentsToText(hover.contents);
      if (hover.range) {
        const l = hover.range.start.line + 1;
        const c = hover.range.start.character + 1;
        return `Hover info at ${l}:${c}:\n\n${text}`;
      }
      return text;
    },
  });
}
