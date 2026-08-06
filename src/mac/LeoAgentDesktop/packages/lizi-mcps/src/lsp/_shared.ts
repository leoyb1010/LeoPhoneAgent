import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { LspToolResult } from './registry.js';
import { LspMcpError } from './errors.js';
import type {
  CallHierarchyItem,
  DocumentSymbol,
  Location,
  LocationLink,
  Position,
  SymbolInformation,
} from './server/lsp-server-process.js';

export const LANGUAGE = 'typescript';

// Mirror @anthropic-ai/claude-agent-sdk cli.js: 10MB hard ceiling for didOpen.
// tsserver chokes on huge generated files and never recovers, so we refuse
// before opening rather than killing the LSP host's project graph.
export const FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

// Mirror Anthropic's per-tool result cap; keeps single tool call comfortably
// below Claude Code's inline display threshold so the LLM parses it directly
// instead of falling back to grep on an offloaded tool-results file.
export const MAX_OUTPUT_CHARS = 100_000;

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
};

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? 'Unknown';
}

export function buildTextResult(text: string, isError = false): LspToolResult {
  return {
    content: [{ type: 'text', text: truncateOutput(text) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function buildErrorTextResult(errorCode: string, message: string): LspToolResult {
  return buildTextResult(`Error [${errorCode}]: ${message}`, true);
}

export function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const suffix = `\n\n... (truncated; output exceeded ${max} chars)`;
  return text.slice(0, max - suffix.length) + suffix;
}

export function resolveFileInWorkdir(workdir: string, file: string): string {
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(workdir, file);
  const rel = path.relative(path.resolve(workdir), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new LspMcpError('INVALID_POSITION', `file is outside workdir: ${file}`);
  }
  return abs;
}

export function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export function toLspPosition(line: number, character: number): Position {
  return { line: line - 1, character: character - 1 };
}

/**
 * Mirror Anthropic's i58: workdir-relative forward-slash path, fallback to the
 * decoded absolute path when the URI is outside the workdir (so out-of-tree
 * results from references / goto-definition still render legibly).
 */
export function relativeFilePath(uri: string, workdir: string): string {
  if (!uri) return '<unknown location>';
  let abs = uri.replace(/^file:\/\//, '');
  // Decode BEFORE stripping the leading `/` — Windows file URIs come as
  // `file:///d%3A/foo`, where the drive-letter colon is percent-encoded.
  // If we test the regex before decoding, `/d%3A/foo` won't match `/<letter>:`
  // and the leading slash sticks around, turning relative paths into absolute
  // ones (caught by bench-lsp.ts on first end-to-end run).
  try {
    abs = decodeURIComponent(abs);
  } catch {
    // keep encoded form on decode error rather than dropping the path entirely
  }
  if (/^\/[A-Za-z]:/.test(abs)) abs = abs.slice(1);
  if (workdir) {
    const rel = path.relative(path.resolve(workdir), abs).replaceAll('\\', '/');
    if (rel && !rel.startsWith('../') && rel !== '..') return rel;
  }
  return abs.replaceAll('\\', '/');
}

export function formatLocationText(loc: Location, workdir: string): string {
  const rel = relativeFilePath(loc.uri, workdir);
  const line = loc.range.start.line + 1;
  const character = loc.range.start.character + 1;
  return `${rel}:${line}:${character}`;
}

export function formatCallHierarchyItemText(item: CallHierarchyItem, workdir: string): string {
  if (!item.uri) return `${item.name} (${symbolKindName(item.kind)}) - <unknown location>`;
  const rel = relativeFilePath(item.uri, workdir);
  const line = item.range.start.line + 1;
  const kind = symbolKindName(item.kind);
  let out = `${item.name} (${kind}) - ${rel}:${line}`;
  if (item.detail) out += ` [${item.detail}]`;
  return out;
}

/**
 * Recursive document symbol formatter; indents by depth, matches Anthropic's
 * IGK output ("name (Kind) [detail] - Line N").
 */
export function formatDocumentSymbolHierarchical(symbol: DocumentSymbol, depth = 0): string[] {
  const indent = '  '.repeat(depth);
  const kind = symbolKindName(symbol.kind);
  let line = `${indent}${symbol.name} (${kind})`;
  if (symbol.detail) line += ` ${symbol.detail}`;
  line += ` - Line ${symbol.range.start.line + 1}`;
  const out = [line];
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      out.push(...formatDocumentSymbolHierarchical(child, depth + 1));
    }
  }
  return out;
}

export function groupLocationsByFile<T extends { uri?: string; location?: { uri: string } }>(
  items: T[],
  workdir: string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const uri = 'uri' in item && item.uri ? item.uri : item.location?.uri;
    if (!uri) continue;
    const file = relativeFilePath(uri, workdir);
    const bucket = groups.get(file);
    if (bucket) bucket.push(item);
    else groups.set(file, [item]);
  }
  return groups;
}

export function normalizeLocations(
  result: Location | LocationLink | Array<Location | LocationLink> | null,
): Location[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.map((item) => {
    if ('targetUri' in item) {
      return { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange };
    }
    return item;
  });
}

export function hoverContentsToText(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((entry) => (typeof entry === 'string' ? entry : (entry as { value?: string })?.value ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
  if (contents && typeof contents === 'object') {
    const value = (contents as { value?: unknown }).value;
    if (typeof value === 'string') return value;
  }
  return contents == null ? '' : String(contents);
}

export function isDocumentSymbol(symbol: DocumentSymbol | SymbolInformation): symbol is DocumentSymbol {
  return 'selectionRange' in symbol;
}

/**
 * gitignore filter — mirrors Anthropic's oGK. Reused by goto_definition /
 * find_references / workspace_symbol so refs landing in build outputs or
 * generated code don't drown the real results.
 */
export async function filterGitIgnoredUris(workdir: string, uris: string[]): Promise<Set<string>> {
  if (uris.length === 0) return new Set();
  const uriToAbs = new Map<string, string>();
  for (const uri of uris) {
    if (!uri || uriToAbs.has(uri)) continue;
    const abs = uriToPath(uri);
    if (abs) uriToAbs.set(uri, abs);
  }
  if (uriToAbs.size === 0) return new Set();

  const files = Array.from(uriToAbs.values());
  const batchSize = 50;
  const batches: string[][] = [];
  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }

  const ignoredAbs = new Set<string>();
  const results = await Promise.all(batches.map((batch) => runGitCheckIgnore(workdir, batch)));
  for (const lines of results) {
    for (const line of lines) ignoredAbs.add(line);
  }

  const ignoredUris = new Set<string>();
  for (const [uri, abs] of uriToAbs) {
    if (ignoredAbs.has(abs)) ignoredUris.add(uri);
  }
  return ignoredUris;
}

function runGitCheckIgnore(workdir: string, batch: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['check-ignore', ...batch],
      { cwd: workdir, timeout: 5_000, windowsHide: true },
      (_err, stdout) => {
        const out: string[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) out.push(trimmed);
        }
        resolve(out);
      },
    );
  });
}

// Compatibility re-export: typescript-launcher and external callers still
// reference fileToUri / pathToFileURL semantics. Kept thin so the v3 surface
// stays Anthropic-aligned without breaking consumers that bypass tools.
export function fileToUri(workdir: string, file: string): string {
  return pathToFileURL(resolveFileInWorkdir(workdir, file)).toString();
}
