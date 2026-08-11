import type { IProviderMcp } from '@/shared/interfaces.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const EMPTY: Record<McpScope, ProviderMcpServer[]> = { user: [], local: [], project: [] };

/**
 * grok manages its own MCP servers via ~/.grok/config.toml. leocodebox does not
 * manage them for v1 (manifest marks mcp `unsupported`), so this is an inert
 * adapter that satisfies the contract without touching grok's config.
 */
export class GrokMcpProvider implements IProviderMcp {
  async listServers(): Promise<Record<McpScope, ProviderMcpServer[]>> {
    return EMPTY;
  }

  async listServersForScope(): Promise<ProviderMcpServer[]> {
    return [];
  }

  async upsertServer(_input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    throw new AppError('Managing MCP servers for Grok is not supported yet.', {
      code: 'MCP_UNSUPPORTED_PROVIDER',
      statusCode: 400,
    });
  }

  async removeServer(): Promise<{ removed: boolean; provider: 'grok'; name: string; scope: McpScope }> {
    throw new AppError('Managing MCP servers for Grok is not supported yet.', {
      code: 'MCP_UNSUPPORTED_PROVIDER',
      statusCode: 400,
    });
  }
}
