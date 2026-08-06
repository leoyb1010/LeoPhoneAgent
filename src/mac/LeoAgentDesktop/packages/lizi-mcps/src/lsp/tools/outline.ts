import { z } from 'zod';

import {
  LANGUAGE,
  formatDocumentSymbolHierarchical,
  groupLocationsByFile,
  isDocumentSymbol,
  resolveFileInWorkdir,
  symbolKindName,
} from '../_shared.js';
import type { DocumentSymbol, SymbolInformation } from '../server/lsp-server-process.js';
import type { LspToolRegistry } from '../registry.js';

const NO_SYMBOLS =
  'No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.';

export function registerOutlineTool(registry: LspToolRegistry): void {
  registry.register({
    name: 'lsp_outline',
    description:
      'Return the semantic TypeScript outline for one file: classes, functions, interfaces, methods, and nested symbols.',
    inputShape: {
      file: z.string().min(1).describe('File path relative to the current workdir.'),
    },
    handler: async ({ file }) => {
      const proc = await registry.deps.pool.getOrSpawn(registry.deps.workdir, LANGUAGE);
      const absPath = resolveFileInWorkdir(registry.deps.workdir, file);
      const uri = await proc.ensureFileOpen(absPath);
      const symbols = (await proc.documentSymbol(uri)) ?? [];
      if (symbols.length === 0) return NO_SYMBOLS;

      // tsserver may return either hierarchical DocumentSymbol[] or flat
      // SymbolInformation[]; detect via selectionRange presence on first entry.
      if (isDocumentSymbol(symbols[0])) {
        const lines = ['Document symbols:'];
        for (const symbol of symbols as DocumentSymbol[]) {
          lines.push(...formatDocumentSymbolHierarchical(symbol));
        }
        return lines.join('\n');
      }

      const flat = symbols as SymbolInformation[];
      const groups = groupLocationsByFile(flat, registry.deps.workdir);
      const lines: string[] = [`Found ${flat.length} symbols:`];
      for (const [filePath, items] of groups) {
        lines.push(`\n${filePath}:`);
        for (const sym of items) {
          const kind = symbolKindName(sym.kind);
          const line = sym.location.range.start.line + 1;
          let entry = `  ${sym.name} (${kind}) - Line ${line}`;
          if (sym.containerName) entry += ` in ${sym.containerName}`;
          lines.push(entry);
        }
      }
      return lines.join('\n');
    },
  });
}
