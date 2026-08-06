import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { buildErrorTextResult, buildTextResult } from './_shared.js';
import { classifyLspError } from './errors.js';
import type { LspMcpDeps } from '../types.js';

export type LspToolContentBlock = { type: 'text'; text: string };

export interface LspToolResult {
  content: LspToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

/**
 * Thin wrapper around McpServer.tool. Handlers return Anthropic-style plain
 * text; errors are wrapped as `Error [CODE]: message` so the LLM can branch on
 * the code without us giving up the text-only output shape on the happy path.
 */
export class LspToolRegistry {
  constructor(
    private readonly server: McpServer,
    readonly deps: LspMcpDeps,
  ) {}

  register<T extends z.ZodRawShape>(def: {
    name: string;
    description: string;
    inputShape: T;
    handler(args: { [K in keyof T]: z.infer<T[K]> }): Promise<string>;
  }): void {
    const registerTool = this.server.tool.bind(this.server) as (...args: unknown[]) => unknown;
    registerTool(def.name, def.description, def.inputShape, async (args: unknown) => {
      try {
        const text = await def.handler(args as { [K in keyof T]: z.infer<T[K]> });
        return buildTextResult(text);
      } catch (err) {
        const { code, message } = classifyLspError(err);
        return buildErrorTextResult(code, message);
      }
    });
  }
}
