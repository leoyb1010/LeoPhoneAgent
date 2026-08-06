import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { LiziMcpLogger } from '../../types.js';
import { LspMcpError } from '../errors.js';
import { FILE_SIZE_LIMIT_BYTES } from '../_shared.js';
import { LspJsonRpcClient } from './jsonrpc.js';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
  originSelectionRange?: Range;
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface Hover {
  contents: unknown;
  range?: Range;
}

export interface CallHierarchyItem {
  name: string;
  kind: number;
  tags?: number[];
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

export type DefinitionResult = Location | Location[] | LocationLink[] | null;
export type ReferencesResult = Location[] | null;
export type WorkspaceSymbolResult = SymbolInformation[] | null;
export type DocumentSymbolResult = Array<DocumentSymbol | SymbolInformation> | null;
export type CallHierarchyPrepareResult = CallHierarchyItem[] | null;
export type CallHierarchyIncomingResult = CallHierarchyIncomingCall[] | null;
export type CallHierarchyOutgoingResult = CallHierarchyOutgoingCall[] | null;

export interface LspServerProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger: LiziMcpLogger;
}

/**
 * Typed facade over a single TypeScript language-server process.
 */
export class LspServerProcess {
  private readonly rpc: LspJsonRpcClient;
  private readonly openUris = new Set<string>();
  private initialized = false;

  constructor(private readonly opts: LspServerProcessOptions) {
    this.rpc = new LspJsonRpcClient({
      command: opts.command,
      args: opts.args,
      spawnOptions: {
        cwd: opts.cwd,
        env: opts.env,
      },
      logger: opts.logger,
    });

    this.rpc.onRequest('workspace/configuration', () => []);
    this.rpc.onRequest('client/registerCapability', () => null);
    this.rpc.onRequest('client/unregisterCapability', () => null);
    this.rpc.onRequest('workspace/workspaceFolders', () => null);
  }

  spawn(): void {
    this.rpc.spawnProcess();
  }

  async initialize(rootUri: string): Promise<void> {
    if (this.initialized) return;
    await this.rpc.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [
        {
          uri: rootUri,
          name: safeWorkspaceName(rootUri),
        },
      ],
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
        },
        textDocument: {
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
          callHierarchy: { dynamicRegistration: false },
        },
      },
    });
    this.rpc.notify('initialized', {});
    this.initialized = true;
  }

  async ensureFileOpen(absPath: string): Promise<string> {
    const normalized = path.resolve(absPath);
    const uri = pathToFileURL(normalized).toString();
    if (this.openUris.has(uri)) return uri;

    // Mirror Anthropic: refuse files past the 10MB ceiling before didOpen.
    // Beyond this size tsserver burns memory indexing and may never recover —
    // the FILE_TOO_LARGE error keeps the project graph healthy for other files.
    const stat = await fs.stat(normalized);
    if (stat.size > FILE_SIZE_LIMIT_BYTES) {
      throw new LspMcpError(
        'FILE_TOO_LARGE',
        `File too large for LSP analysis (${Math.ceil(stat.size / 1_000_000)}MB exceeds ${Math.floor(FILE_SIZE_LIMIT_BYTES / 1_000_000)}MB limit): ${absPath}`,
      );
    }

    const text = await fs.readFile(normalized, 'utf8');
    this.rpc.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageIdForFile(normalized),
        version: 1,
        text,
      },
    });
    this.openUris.add(uri);
    return uri;
  }

  workspaceSymbol(query: string): Promise<WorkspaceSymbolResult> {
    return this.rpc.request('workspace/symbol', { query });
  }

  documentSymbol(uri: string): Promise<DocumentSymbolResult> {
    return this.rpc.request('textDocument/documentSymbol', { textDocument: { uri } });
  }

  definition(uri: string, position: Position): Promise<DefinitionResult> {
    return this.rpc.request('textDocument/definition', { textDocument: { uri }, position });
  }

  references(uri: string, position: Position, includeDeclaration: boolean): Promise<ReferencesResult> {
    return this.rpc.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
  }

  hover(uri: string, position: Position): Promise<Hover | null> {
    return this.rpc.request('textDocument/hover', { textDocument: { uri }, position });
  }

  prepareCallHierarchy(uri: string, position: Position): Promise<CallHierarchyPrepareResult> {
    return this.rpc.request('textDocument/prepareCallHierarchy', { textDocument: { uri }, position });
  }

  incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingResult> {
    return this.rpc.request('callHierarchy/incomingCalls', { item });
  }

  outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingResult> {
    return this.rpc.request('callHierarchy/outgoingCalls', { item });
  }

  async shutdown(): Promise<void> {
    if (this.initialized) {
      try {
        await this.rpc.request('shutdown', null);
      } catch (err) {
        this.opts.logger.warn('LSP shutdown request failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      this.rpc.notify('exit');
      this.initialized = false;
      this.openUris.clear();
    }
    await this.rpc.close('LspServerProcess.shutdown()');
  }
}

function safeWorkspaceName(rootUri: string): string {
  try {
    const parts = fileURLToPath(rootUri).split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? 'workspace';
  } catch {
    return 'workspace';
  }
}

function languageIdForFile(absPath: string): 'typescript' | 'typescriptreact' {
  return absPath.endsWith('.tsx') ? 'typescriptreact' : 'typescript';
}
