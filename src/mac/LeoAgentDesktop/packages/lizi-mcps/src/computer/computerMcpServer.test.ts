import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createComputerMcpServer } from './server.js';
import type { ComputerMcpDeps } from '../types.js';

/** Temp session workingDir for path-boundary-constrained tools (recording/replay). */
async function makeWorkingDir(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'computer-wd-')));
}

function textPayload(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (!first?.text) throw new Error('missing text payload');
  return JSON.parse(first.text);
}

async function makeHarness(deps: ComputerMcpDeps, options?: Parameters<typeof createComputerMcpServer>[1]) {
  const server = createComputerMcpServer(deps, options);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'computer-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('createComputerMcpServer', () => {
  it('lists desktop computer-use tools', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({ name: 'list_tools', arguments: {} })) as {
      ok: boolean;
      tools: Array<{
        name: string;
        description: string;
        inputSchema?: { properties?: Record<string, unknown> };
      }>;
      workflow: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.tools.map((tool) => tool.name)).toContain('get_window_state');
    expect(payload.tools.map((tool) => tool.name)).toContain('get_accessibility_tree');
    expect(payload.tools.map((tool) => tool.name)).toContain('move_cursor');
    expect(payload.tools.map((tool) => tool.name)).toContain('start_recording');
    expect(payload.tools.map((tool) => tool.name)).toContain('replay_trajectory');
    expect(payload.tools.map((tool) => tool.name)).toContain('type_text');
    const listWindows = payload.tools.find((tool) => tool.name === 'list_windows');
    expect(listWindows?.inputSchema?.properties).toHaveProperty('query');
    expect(listWindows?.inputSchema?.properties).toHaveProperty('workspace_root');
    expect(listWindows?.inputSchema?.properties).toHaveProperty('process_name');
    expect(payload.workflow).toContain('query/workspace_root/process_name');
    expect(listWindows?.description).toContain('{"process_name":"Simulator"}');
    expect(payload.tools.find((tool) => tool.name === 'get_window_state')?.description)
      .toContain('{"capture_mode":"vision"}');
    expect(payload.tools.find((tool) => tool.name === 'click')?.description)
      .toContain('Always include pid');
    expect(payload.tools.find((tool) => tool.name === 'launch_app')?.description)
      .toContain('{"process_name":"Simulator"}');
    expect(payload.workflow).toContain('always for coordinates');
    expect(payload.workflow).toContain('{"capture_mode":"vision"}');
    await h.cleanup();
  });

  it('routes status without calling the external driver call path', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(async () => ({
        installed: true,
        executablePath: 'cua-driver',
        version: 'cua-driver 1.2.3',
        daemonRunning: true,
        installCommand: 'install cua-driver',
        docsUrl: 'https://cua.ai/docs/cua-driver',
      })),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'status', args: {} },
    })) as {
      ok: boolean;
      data: { installed: boolean; version: string };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.installed).toBe(true);
    expect(payload.data.version).toBe('cua-driver 1.2.3');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('checks permissions in read-only mode', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(async () => ({
        installed: true,
        executablePath: 'cua-driver',
        version: 'cua-driver 1.2.3',
        daemonRunning: false,
        permissionState: {
          platform: 'macos' as const,
          required: true,
          status: 'missing' as const,
          accessibility: 'missing' as const,
          screenRecording: 'missing' as const,
          canGrant: true,
        },
        installCommand: 'install cua-driver',
        docsUrl: 'https://cua.ai/docs/cua-driver',
      })),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'check_permissions', args: {} },
    })) as { ok: boolean; data: { daemonRunning: boolean; permissionState: { status: string } } };

    expect(payload.ok).toBe(true);
    expect(payload.data.daemonRunning).toBe(false);
    expect(payload.data.permissionState.status).toBe('missing');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches lightweight accessibility tree discovery', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'get_accessibility_tree', args: {} },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_accessibility_tree', {});
    await h.cleanup();
  });

  it('dispatches list_windows with filters and current session context', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: {
          query: 'settings',
          workspace_root: '/repo',
          process_name: 'Electron',
        },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('list_windows', {
      query: 'settings',
      workspace_root: '/repo',
      process_name: 'Electron',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('normalizes the list_windows app compatibility alias without forwarding it', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: { app: 'Simulator' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('list_windows', {
      process_name: 'Simulator',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('accepts a list_windows alias that matches the canonical process_name', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ windows: [] })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: { app: 'Simulator', process_name: 'Simulator' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('list_windows', {
      process_name: 'Simulator',
    });
    await h.cleanup();
  });

  it('rejects conflicting list_windows alias and canonical values', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'list_windows',
        args: { app: 'Simulator', process_name: 'Xcode' },
      },
    });
    const payload = textPayload(result) as {
      ok: boolean;
      errorCode: string;
      data: { validation_errors: Array<{ message: string }> };
    };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(payload.data.validation_errors[0]?.message).toContain('use only process_name');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('normalizes screenshot true to capture_mode vision without forwarding the alias', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ elements: [] })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: { pid: 123, window_id: 7, screenshot: true },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('accepts screenshot true when capture_mode is already vision', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ elements: [] })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: { pid: 123, window_id: 7, screenshot: true, capture_mode: 'vision' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
    });
    await h.cleanup();
  });

  it('rejects screenshot true when capture_mode conflicts', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: { pid: 123, window_id: 7, screenshot: true, capture_mode: 'som' },
      },
    });
    const payload = textPayload(result) as {
      ok: boolean;
      errorCode: string;
      data: { validation_errors: Array<{ message: string }> };
    };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(payload.data.validation_errors[0]?.message).toContain('use only capture_mode');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it.each([
    ['non-string app', 'list_windows', { app: 42 }],
    ['non-string canonical with app alias', 'list_windows', { app: 'Simulator', process_name: 42 }],
    ['false screenshot', 'get_window_state', { pid: 123, window_id: 7, screenshot: false }],
    ['non-boolean screenshot', 'get_window_state', { pid: 123, window_id: 7, screenshot: 'true' }],
    ['invalid canonical with screenshot alias', 'get_window_state', {
      pid: 123,
      window_id: 7,
      screenshot: true,
      capture_mode: 'bogus',
    }],
    ['app on another tool', 'launch_app', { app: 'Simulator' }],
  ])('keeps strict validation for %s', async (_caseName, name, args) => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name, args },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('validates tool args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'type_text', args: { pid: 123 } },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches zoom with cua-driver 0.5 region bounds', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'zoom',
        args: { window_id: 7, x1: 10, y1: 20, x2: 110, y2: 120 },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('zoom', {
      window_id: 7,
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 120,
    });
    await h.cleanup();
  });

  it('dispatches launch_app with current cua-driver args', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: {
          bundle_id: 'com.example.app',
          creates_new_application_instance: true,
          electron_debugging_port: 9222,
          additional_arguments: ['--flag'],
        },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('launch_app', {
      bundle_id: 'com.example.app',
      creates_new_application_instance: true,
      electron_debugging_port: 9222,
      additional_arguments: ['--flag'],
    });
    await h.cleanup();
  });

  it('rejects legacy launch_app args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: { path: '/Applications/Test.app', wait_ms: 500 },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches set_value with value and required window_id', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'set_value',
        args: { pid: 123, window_id: 7, element_index: 2, value: 'Option' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('set_value', {
      pid: 123,
      window_id: 7,
      element_index: 2,
      value: 'Option',
    });
    await h.cleanup();
  });

  it('rejects legacy set_value text args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'set_value',
        args: { pid: 123, element_index: 2, text: 'Option' },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches scroll with current direction-based args', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'scroll',
        args: { pid: 123, direction: 'down', amount: 3, by: 'page' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('scroll', {
      pid: 123,
      direction: 'down',
      amount: 3,
      by: 'page',
    });
    await h.cleanup();
  });

  it('injects the current session id into session-aware action tools', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'click',
        args: { pid: 123, window_id: 7, x: 10, y: 20 },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('click', {
      pid: 123,
      window_id: 7,
      x: 10,
      y: 20,
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('resolves dynamic session context at tool-call time', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    let sessionId = 'dynamic-session-1';
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId,
      }),
    });

    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'click',
        args: { pid: 123, window_id: 7, x: 10, y: 20 },
      },
    });
    sessionId = 'dynamic-session-2';
    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'click',
        args: { pid: 123, window_id: 7, x: 11, y: 21 },
      },
    });
    const payload = textPayload(result) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenNthCalledWith(1, 'click', {
      pid: 123,
      window_id: 7,
      x: 10,
      y: 20,
      session: 'dynamic-session-1',
    }, { sessionId: 'dynamic-session-1', agentKind: 'codex' });
    expect(deps.callTool).toHaveBeenNthCalledWith(2, 'click', {
      pid: 123,
      window_id: 7,
      x: 11,
      y: 21,
      session: 'dynamic-session-2',
    }, { sessionId: 'dynamic-session-2', agentKind: 'codex' });
    await h.cleanup();
  });

  it('overrides caller-supplied session ids with the host session id', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'move_cursor',
        args: { x: 10, y: 20, cursor_id: 'stale-manual-cursor', session: 'manual-session' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('move_cursor', {
      x: 10,
      y: 20,
      cursor_id: 'agent-session-1',
      session: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('maps cursor-state reads to the host session cursor id', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const h = await makeHarness(deps, { sessionId: 'agent-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_agent_cursor_state',
        args: { cursor_id: 'stale-manual-cursor' },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('get_agent_cursor_state', {
      cursor_id: 'agent-session-1',
    }, { sessionId: 'agent-session-1' });
    await h.cleanup();
  });

  it('dispatches trajectory recording tools with the current session id (output_dir constrained to workingDir)', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    // output_dir is a local write path → constrained to the session workingDir;
    // a relative arg resolves to an absolute path inside it before dispatch.
    const root = await makeWorkingDir();
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'claude-code',
        workingDir: root,
        sessionId: 'recording-session',
      }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'start_recording',
        args: { output_dir: 'rec', record_video: true },
      },
    })) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith('start_recording', {
      output_dir: path.join(root, 'rec'),
      record_video: true,
      session: 'recording-session',
    }, { sessionId: 'recording-session', agentKind: 'claude-code' });
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a recording output_dir outside the session workingDir', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const root = await makeWorkingDir();
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'claude-code',
        workingDir: root,
        sessionId: 'recording-session',
      }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'start_recording',
        args: { output_dir: '/tmp/cua-recording', record_video: true },
      },
    })) as { ok: boolean; errorCode?: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('suggests the driver default or workingDir for rejected screenshot paths', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const root = await makeWorkingDir();
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'claude-code',
        workingDir: root,
        sessionId: 'screenshot-session',
      }),
    });

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: {
          pid: 123,
          window_id: 7,
          capture_mode: 'vision',
          screenshot_out_file: path.resolve(root, '..', 'outside.png'),
        },
      },
    })) as { ok: boolean; errorCode: string; data: { message: string } };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(payload.data.message).toContain('省略 screenshot_out_file');
    expect(payload.data.message).toContain('workingDir 内');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('suggests omitting screenshot_out_file when the session has no workingDir', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const payload = textPayload(await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_window_state',
        args: {
          pid: 123,
          window_id: 7,
          capture_mode: 'vision',
          screenshot_out_file: 'state.png',
        },
      },
    })) as { ok: boolean; errorCode: string; data: { message: string } };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(payload.data.message).toContain('省略 screenshot_out_file');
    expect(payload.data.message).toContain('driver 使用默认路径');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('dispatches replay trajectory tool (dir constrained to workingDir)', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(async () => ({ ok: true })),
    };
    const root = await makeWorkingDir();
    const h = await makeHarness(deps, {
      getSessionContext: () => ({ agentKind: 'claude-code', workingDir: root }),
    });

    await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'replay_trajectory',
        args: { dir: 'rec', delay_ms: 100, stop_on_error: false },
      },
    });

    expect(deps.callTool).toHaveBeenCalledWith('replay_trajectory', {
      dir: path.join(root, 'rec'),
      delay_ms: 100,
      stop_on_error: false,
    }, { agentKind: 'claude-code' });
    await h.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects legacy scroll delta args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'scroll',
        args: { pid: 123, delta_y: 300 },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('rejects legacy zoom x/y/width/height args before dispatch', async () => {
    const deps: ComputerMcpDeps = {
      getStatus: vi.fn(),
      callTool: vi.fn(),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'zoom',
        args: { window_id: 7, x: 10, y: 20, width: 100, height: 100 },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });
});
