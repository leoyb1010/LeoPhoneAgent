import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  extractToolResultErrorCode,
  logToolResultErrorCode,
} from '../tool-error-telemetry.js';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import { createComputerMcpServer } from '../computer/server.js';
import type { ComputerMcpDeps, LiziMcpLogger } from '../types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function makeLogger(): LiziMcpLogger & { warn: ReturnType<typeof vi.fn> } {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function connect(server: McpServer) {
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'telemetry-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textResult(payload: unknown, isError?: boolean) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

describe('extractToolResultErrorCode', () => {
  it('extracts errorCode from the first text block payload', () => {
    const result = textResult({ ok: false, errorCode: 'UNKNOWN_TOOL', data: {} }, true);
    expect(extractToolResultErrorCode(result)).toBe('UNKNOWN_TOOL');
  });

  it('returns null for ok payloads and non-JSON text', () => {
    expect(extractToolResultErrorCode(textResult({ ok: true, data: {} }))).toBeNull();
    expect(
      extractToolResultErrorCode({ content: [{ type: 'text', text: 'plain text' }] }),
    ).toBeNull();
    expect(extractToolResultErrorCode({ content: undefined })).toBeNull();
  });
});

describe('logToolResultErrorCode', () => {
  it('logs a structured warn when the result carries an errorCode', () => {
    const logger = makeLogger();
    logToolResultErrorCode({
      logger,
      server: 'cindy_test',
      tool: 'do_thing',
      result: textResult({ ok: false, errorCode: 'INVALID_ARGS' }, true),
      sessionId: 'sess-1',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('tool call returned errorCode', {
      server: 'cindy_test',
      tool: 'do_thing',
      errorCode: 'INVALID_ARGS',
      sessionId: 'sess-1',
    });
  });

  it('logs isError results even without a parseable errorCode', () => {
    const logger = makeLogger();
    logToolResultErrorCode({
      logger,
      server: 'cindy_test',
      tool: 'do_thing',
      result: { content: [{ type: 'text', text: 'boom' }], isError: true },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('tool call returned errorCode', {
      server: 'cindy_test',
      tool: 'do_thing',
      errorCode: null,
    });
  });

  it('stays silent on ok results and tolerates a missing logger', () => {
    const logger = makeLogger();
    logToolResultErrorCode({
      logger,
      server: 'cindy_test',
      tool: 'do_thing',
      result: textResult({ ok: true, data: {} }),
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(() =>
      logToolResultErrorCode({
        logger: undefined,
        server: 'cindy_test',
        tool: 'do_thing',
        result: textResult({ ok: false, errorCode: 'X' }, true),
      }),
    ).not.toThrow();
  });

  it('never parses results without isError (success payloads stay zero-cost)', () => {
    const logger = makeLogger();
    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      // 契约:错误结果必须带 isError: true(errorPayload / textResult(x, true));
      // 没带的即使 text 里有 errorCode 也按成功结果对待,不解析、不记录。
      logToolResultErrorCode({
        logger,
        server: 'cindy_test',
        tool: 'do_thing',
        result: textResult({ ok: false, errorCode: 'NOT_FLAGGED' }),
      });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe('xdt-helper call_tool errorCode telemetry', () => {
  const sessionCtx = {
    agentKind: 'claude-code' as const,
    workingDir: '/tmp',
    sessionId: 'sess-xdt',
  };

  it('logs UNKNOWN_TOOL with server/tool/sessionId', async () => {
    const logger = makeLogger();
    const h = await connect(createXdtHelperMcpServer({ logger }, sessionCtx));

    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'no_such_tool', args: {} },
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('tool call returned errorCode', {
      server: 'cindy_helper',
      tool: 'no_such_tool',
      errorCode: 'UNKNOWN_TOOL',
      sessionId: 'sess-xdt',
    });
    await h.cleanup();
  });

  it('logs INVALID_ARGS on schema violations and stays silent on success', async () => {
    const logger = makeLogger();
    const h = await connect(createXdtHelperMcpServer({ logger }, sessionCtx));

    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_capabilities', args: { bogus_field: 1 } },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('tool call returned errorCode', {
      server: 'cindy_helper',
      tool: 'get_capabilities',
      errorCode: 'INVALID_ARGS',
      sessionId: 'sess-xdt',
    });

    logger.warn.mockClear();
    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_capabilities', args: {} },
    });
    expect(logger.warn).not.toHaveBeenCalled();
    await h.cleanup();
  });
});

describe('computer call_tool errorCode telemetry', () => {
  it('logs COMPUTER_DRIVER_ERROR when the driver call throws', async () => {
    const logger = makeLogger();
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => {
        throw new Error('driver exploded');
      }),
      logger,
    };
    const h = await connect(createComputerMcpServer(deps, { sessionId: 'sess-cua' }));

    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_screen_size', args: {} },
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('tool call returned errorCode', {
      server: 'cindy_computer',
      tool: 'get_screen_size',
      errorCode: 'COMPUTER_DRIVER_ERROR',
      sessionId: 'sess-cua',
    });
    await h.cleanup();
  });

  it('logs INVALID_ARGS and stays silent on successful calls', async () => {
    const logger = makeLogger();
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ width: 100, height: 100 })),
      logger,
    };
    const h = await connect(createComputerMcpServer(deps, { sessionId: 'sess-cua' }));

    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_screen_size', args: { bogus: true } },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('tool call returned errorCode', {
      server: 'cindy_computer',
      tool: 'get_screen_size',
      errorCode: 'INVALID_ARGS',
      sessionId: 'sess-cua',
    });

    logger.warn.mockClear();
    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_screen_size', args: {} },
    });
    expect(logger.warn).not.toHaveBeenCalled();
    await h.cleanup();
  });
});
