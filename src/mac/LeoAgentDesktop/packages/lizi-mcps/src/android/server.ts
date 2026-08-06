import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AndroidMcpCallContext, AndroidMcpDeps, LiziMcpSessionContext } from '../types.js';
import { jsonObjectArg } from '../json-object-arg.js';
import { AndroidToolRegistry } from './tool-registry.js';
import { registerAndroidTools } from './tools.js';

export interface AndroidMcpServerOptions {
  sessionId?: string;
  getSessionContext?: () => LiziMcpSessionContext;
}

const DESCRIPTION_LIST =
  'Discover Android adb automation tools. Use list_tools first, then call_tool with validated args.';

const DESCRIPTION_CALL =
  'Invoke one Android adb automation tool. Arguments are validated before dispatching to the host.';

const CATEGORY_ENUM = ['android'] as const;

function readCallContext(options: AndroidMcpServerOptions): AndroidMcpCallContext | undefined {
  const sessionContext = options.getSessionContext?.();
  const sessionId = sessionContext?.sessionId ?? options.sessionId;
  const agentKind = sessionContext?.agentKind;
  return sessionId || agentKind
    ? {
        ...(sessionId ? { sessionId } : {}),
        ...(agentKind ? { agentKind } : {}),
      }
    : undefined;
}

export function createAndroidMcpServer(
  deps: AndroidMcpDeps,
  options: AndroidMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: 'cindy_android',
    version: '0.1.0',
  });
  const registry = new AndroidToolRegistry();
  registerAndroidTools(registry, deps, () => readCallContext(options));

  server.tool(
    'list_tools',
    DESCRIPTION_LIST,
    {
      category: z.enum(CATEGORY_ENUM).optional().describe('Tool category. Omit to list categories overview.'),
    },
    async ({ category }) => {
      if (category) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category,
                tools: registry.list(category),
                workflow:
                  'Start with status or list_devices. Use get_device_state before tap/swipe/input_text/press_key/launch_app. Re-read get_device_state after each action to verify results.',
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().map((name) => ({
                name,
                tool_count: registry.list(name).length,
              })),
              hint: 'Use list_tools({category:"android"}) to inspect the Android tool list.',
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'call_tool',
    DESCRIPTION_CALL,
    {
      name: z.string().describe('Tool name from list_tools'),
      args: jsonObjectArg('Arguments object for the selected tool'),
    },
    async ({ name, args }) => registry.call(name, args),
  );

  return server;
}
