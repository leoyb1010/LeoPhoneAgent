import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { LspToolRegistry } from './registry.js';
import {
  registerGotoDefinitionTool,
  registerFindReferencesTool,
  registerWorkspaceSymbolTool,
  registerOutlineTool,
  registerHoverTool,
  registerIncomingCallsTool,
} from './tools/index.js';
import type { LspMcpDeps } from '../types.js';

export function createCindyLspMcpServer(deps: LspMcpDeps): McpServer {
  const server = new McpServer({
    name: 'cindy_lsp',
    version: '1.0.0',
  });

  const registry = new LspToolRegistry(server, deps);
  registerGotoDefinitionTool(registry);
  registerFindReferencesTool(registry);
  registerWorkspaceSymbolTool(registry);
  registerOutlineTool(registry);
  registerHoverTool(registry);
  registerIncomingCallsTool(registry);

  return server;
}
