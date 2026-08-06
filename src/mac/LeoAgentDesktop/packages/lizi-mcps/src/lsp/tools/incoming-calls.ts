import { z } from 'zod';

import {
  LANGUAGE,
  formatCallHierarchyItemText,
  relativeFilePath,
  resolveFileInWorkdir,
  symbolKindName,
  toLspPosition,
} from '../_shared.js';
import type { CallHierarchyIncomingCall } from '../server/lsp-server-process.js';
import type { LspToolRegistry } from '../registry.js';

export function registerIncomingCallsTool(registry: LspToolRegistry): void {
  registry.register({
    name: 'lsp_incoming_calls',
    description:
      'Find functions or methods that call the TypeScript function/method at a concrete file position using LSP call hierarchy.',
    inputShape: {
      file: z.string().min(1).describe('File path relative to the current workdir.'),
      line: z.number().int().min(1).describe('1-based line number, as shown in editors.'),
      character: z.number().int().min(1).describe('1-based character offset, as shown in editors.'),
    },
    handler: async ({ file, line, character }) => {
      const proc = await registry.deps.pool.getOrSpawn(registry.deps.workdir, LANGUAGE);
      const absPath = resolveFileInWorkdir(registry.deps.workdir, file);
      const uri = await proc.ensureFileOpen(absPath);
      const items = (await proc.prepareCallHierarchy(uri, toLspPosition(line, character))) ?? [];
      if (items.length === 0) return 'No call hierarchy item found at this position';

      // tsserver returns a single root for an identifier; multi-head only matters
      // for languages with overload sets exposed as separate items (Java, C#).
      const calls = ((await proc.incomingCalls(items[0])) ?? []).filter(
        (call): call is CallHierarchyIncomingCall => Boolean(call.from),
      );
      if (calls.length === 0) {
        const head = formatCallHierarchyItemText(items[0], registry.deps.workdir);
        return `Call hierarchy item: ${head}\n\nNo incoming calls found (nothing calls this function)`;
      }

      const noun = calls.length === 1 ? 'call' : 'calls';
      const head = formatCallHierarchyItemText(items[0], registry.deps.workdir);
      const lines: string[] = [`Call hierarchy item: ${head}`, '', `Found ${calls.length} incoming ${noun}:`];
      const groups = new Map<string, CallHierarchyIncomingCall[]>();
      for (const call of calls) {
        const filePath = relativeFilePath(call.from.uri, registry.deps.workdir);
        const bucket = groups.get(filePath);
        if (bucket) bucket.push(call);
        else groups.set(filePath, [call]);
      }
      for (const [filePath, items2] of groups) {
        lines.push(`\n${filePath}:`);
        for (const call of items2) {
          const kind = symbolKindName(call.from.kind);
          const l = call.from.range.start.line + 1;
          let entry = `  ${call.from.name} (${kind}) - Line ${l}`;
          if (call.fromRanges && call.fromRanges.length > 0) {
            const positions = call.fromRanges
              .map((r) => `${r.start.line + 1}:${r.start.character + 1}`)
              .join(', ');
            entry += ` [calls at: ${positions}]`;
          }
          lines.push(entry);
        }
      }
      return lines.join('\n');
    },
  });
}
