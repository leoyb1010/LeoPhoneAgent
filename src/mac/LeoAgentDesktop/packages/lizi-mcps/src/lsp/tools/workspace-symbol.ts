import { z } from 'zod';

import {
  LANGUAGE,
  filterGitIgnoredUris,
  groupLocationsByFile,
  resolveFileInWorkdir,
  symbolKindName,
} from '../_shared.js';
import type { LspToolRegistry } from '../registry.js';

const NO_SYMBOLS =
  'No symbols found in workspace. This may occur if the LSP has not opened the relevant file yet — typescript-language-server only indexes files passed via didOpen. Try opening the file via another tool (lsp_outline / lsp_hover) before searching, or grep for the symbol and use lsp_goto_definition on a concrete position.';

export function registerWorkspaceSymbolTool(registry: LspToolRegistry): void {
  registry.register({
    name: 'lsp_workspace_symbol',
    description:
      'Search TypeScript symbols across the project containing anchorFile. NOTE: typescript-language-server only returns symbols from files it has already opened, so results are scoped to the project graph anchored on anchorFile. Empty query lists all indexed symbols.',
    inputShape: {
      anchorFile: z.string().min(1).describe('A TypeScript file path that anchors the project to query.'),
      query: z.string().optional().describe('Optional symbol search query. Default empty string lists all indexed symbols.'),
    },
    handler: async ({ anchorFile, query }) => {
      const proc = await registry.deps.pool.getOrSpawn(registry.deps.workdir, LANGUAGE);
      const absPath = resolveFileInWorkdir(registry.deps.workdir, anchorFile);
      await proc.ensureFileOpen(absPath);
      const symbols = ((await proc.workspaceSymbol(query ?? '')) ?? []).filter(
        (sym) => sym && sym.location && sym.location.uri,
      );
      if (symbols.length === 0) return NO_SYMBOLS;

      const ignored = await filterGitIgnoredUris(
        registry.deps.workdir,
        symbols.map((sym) => sym.location.uri),
      );
      const visible = symbols.filter((sym) => !ignored.has(sym.location.uri));
      if (visible.length === 0) return NO_SYMBOLS;

      const noun = visible.length === 1 ? 'symbol' : 'symbols';
      const groups = groupLocationsByFile(visible, registry.deps.workdir);
      const lines: string[] = [`Found ${visible.length} ${noun} in workspace:`];
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
