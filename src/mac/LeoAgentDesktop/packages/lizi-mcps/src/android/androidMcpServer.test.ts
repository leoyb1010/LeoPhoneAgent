import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createAndroidMcpServer } from './server.js';
import { INLINE_IMAGE_TARGET_BYTES, type AndroidMcpDeps } from '../types.js';

function textPayload(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (!first?.text) throw new Error('missing text payload');
  return JSON.parse(first.text);
}

async function makeHarness(
  deps: AndroidMcpDeps,
  options: Parameters<typeof createAndroidMcpServer>[1] = {},
) {
  const server = createAndroidMcpServer(deps, options);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'android-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('createAndroidMcpServer', () => {
  it('lists Android adb tools', async () => {
    const deps: AndroidMcpDeps = { callTool: vi.fn() };
    const h = await makeHarness(deps, { sessionId: 'android-session-1' });

    const payload = textPayload(await h.client.callTool({
      name: 'list_tools',
      arguments: { category: 'android' },
    })) as { ok: boolean; tools: Array<{ name: string }> };

    expect(payload.ok).toBe(true);
    expect(payload.tools.map((tool) => tool.name)).toEqual([
      'status',
      'list_devices',
      'get_device_state',
      'tap',
      'swipe',
      'input_text',
      'press_key',
      'launch_app',
    ]);
    await h.cleanup();
  });

  it('validates tool args before dispatch', async () => {
    const deps: AndroidMcpDeps = { callTool: vi.fn() };
    const h = await makeHarness(deps, { sessionId: 'android-session-1' });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'launch_app',
        args: { package: '' },
      },
    });
    const payload = textPayload(result) as { ok: boolean; errorCode: string };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('INVALID_ARGS');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(deps.callTool).not.toHaveBeenCalled();
    await h.cleanup();
  });

  it('accepts stringified call_tool args before tool-specific validation', async () => {
    const deps: AndroidMcpDeps = {
      callTool: vi.fn(async () => ({
        ok: true,
        data: { input: 'ok' },
      })),
    };
    const h = await makeHarness(deps, { sessionId: 'android-session-1' });
    const text = 'x'.repeat(20_000);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'input_text',
        args: JSON.stringify({ device_serial: 'emulator-5554', text }),
      },
    });
    const payload = textPayload(result) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(deps.callTool).toHaveBeenCalledWith(
      'input_text',
      { device_serial: 'emulator-5554', text },
      { sessionId: 'android-session-1' },
    );
    await h.cleanup();
  });

  it('forwards the runtime agent kind with the current session context', async () => {
    const deps: AndroidMcpDeps = {
      callTool: vi.fn(async () => ({ ok: true, data: [] })),
    };
    const h = await makeHarness(deps, {
      getSessionContext: () => ({
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'android-codex-session',
      }),
    });

    await h.client.callTool({
      name: 'call_tool',
      arguments: { name: 'list_devices', args: {} },
    });

    expect(deps.callTool).toHaveBeenCalledWith(
      'list_devices',
      {},
      { sessionId: 'android-codex-session', agentKind: 'codex' },
    );
    await h.cleanup();
  });

  it('returns screenshot image blocks for get_device_state', async () => {
    const deps: AndroidMcpDeps = {
      callTool: vi.fn(async () => ({
        ok: true,
        data: {
          device_serial: 'emulator-5554',
          screen: { width: 1080, height: 2400, density: 440 },
          current_app: { package: 'com.example', activity: '.MainActivity' },
          screenshot_file_path: '/tmp/state.png',
          screenshot_base64: 'iVBORw0KGgo=',
          screenshot_mime_type: 'image/png',
          nodes: [
            {
              index: 1,
              text: 'OK',
              bounds: { x1: 10, y1: 20, x2: 100, y2: 80 },
              clickable: true,
              enabled: true,
            },
          ],
        },
      })),
    };
    const h = await makeHarness(deps, { sessionId: 'android-session-1' });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_device_state',
        args: { device_serial: 'emulator-5554' },
      },
    });

    const payload = textPayload(result) as { ok: boolean; data: { screenshot_file_path: string } };
    expect(payload.ok).toBe(true);
    expect(payload.data.screenshot_file_path).toBe('/tmp/state.png');
    expect((result as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content[1]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
    expect(deps.callTool).toHaveBeenCalledWith(
      'get_device_state',
      { device_serial: 'emulator-5554' },
      { sessionId: 'android-session-1' },
    );
    await h.cleanup();
  });

  it('compresses large inline get_device_state screenshots', async () => {
    const width = 900;
    const height = 900;
    const pixels = randomBytes(width * height * 3);
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    expect(png.byteLength).toBeGreaterThan(INLINE_IMAGE_TARGET_BYTES);

    const deps: AndroidMcpDeps = {
      callTool: vi.fn(async () => ({
        ok: true,
        data: {
          device_serial: 'emulator-5554',
          screen: { width, height, density: 440 },
          current_app: { package: 'com.example', activity: '.MainActivity' },
          screenshot_file_path: '/tmp/state.png',
          screenshot_base64: png.toString('base64'),
          screenshot_mime_type: 'image/png',
          nodes: [],
        },
      })),
    };
    const h = await makeHarness(deps, { sessionId: 'android-session-1' });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_device_state',
        args: { device_serial: 'emulator-5554' },
      },
    });

    const image = (result as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content[1];
    expect(image.type).toBe('image');
    expect(image.mimeType).toBe('image/jpeg');
    expect(Buffer.from(image.data ?? '', 'base64').byteLength).toBeLessThanOrEqual(INLINE_IMAGE_TARGET_BYTES);
    expect((image.data ?? '').length).toBeLessThan(png.toString('base64').length);
    await h.cleanup();
  });

  it('bounds get_device_state node text payloads', async () => {
    const longText = 'node-text-'.repeat(1200);
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      index: index + 1,
      text: longText,
      content_desc: longText,
      resource_id: `com.example:id/${longText}`,
      class_name: `android.widget.${longText}`,
      package: `com.example.${longText}`,
      bounds: { x1: 0, y1: index, x2: 100, y2: index + 10 },
      clickable: true,
      enabled: true,
    }));
    const deps: AndroidMcpDeps = {
      callTool: vi.fn(async () => ({
        ok: true,
        data: {
          device_serial: 'emulator-5554',
          screen: { width: 1080, height: 2400, density: 440 },
          current_app: { package: 'com.example', activity: '.MainActivity' },
          screenshot_file_path: '/tmp/state.png',
          screenshot_base64: 'iVBORw0KGgo=',
          screenshot_mime_type: 'image/png',
          raw_ui_dump_file_path: '/tmp/state.xml',
          nodes,
        },
      })),
    };
    const h = await makeHarness(deps, { sessionId: 'android-session-1' });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_device_state',
        args: { device_serial: 'emulator-5554' },
      },
    });

    const text = (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      ok: boolean;
      data: {
        nodes: Array<{ text?: string; content_desc?: string; resource_id?: string }>;
        nodes_truncated?: boolean;
        raw_ui_dump_file_path?: string;
      };
    };
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(INLINE_IMAGE_TARGET_BYTES);
    expect(payload.ok).toBe(true);
    expect(payload.data.nodes_truncated).toBe(true);
    expect(payload.data.raw_ui_dump_file_path).toBe('/tmp/state.xml');
    expect(payload.data.nodes.length).toBeLessThan(nodes.length);
    expect(payload.data.nodes[0]?.text?.length).toBeLessThan(longText.length);
    expect(payload.data.nodes[0]?.content_desc?.length).toBeLessThan(longText.length);
    expect(payload.data.nodes[0]?.resource_id?.length).toBeLessThan(longText.length);
    await h.cleanup();
  });

  it('shares get_device_state stream budget between text and image blocks', async () => {
    const image = randomBytes(INLINE_IMAGE_TARGET_BYTES - 1);
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      index: index + 1,
      text: `Button ${index} ${'verbose-label-'.repeat(80)}`,
      content_desc: `Description ${index} ${'verbose-desc-'.repeat(80)}`,
      resource_id: `com.example:id/${'deep_resource_'.repeat(60)}${index}`,
      class_name: 'android.widget.TextView',
      package: 'com.example',
      bounds: { x1: 0, y1: index, x2: 100, y2: index + 10 },
      clickable: true,
      enabled: true,
    }));
    const deps: AndroidMcpDeps = {
      callTool: vi.fn(async () => ({
        ok: true,
        data: {
          device_serial: 'emulator-5554',
          screen: { width: 1080, height: 2400, density: 440 },
          current_app: { package: 'com.example', activity: '.MainActivity' },
          screenshot_file_path: '/tmp/state.png',
          screenshot_base64: image.toString('base64'),
          screenshot_mime_type: 'image/png',
          raw_ui_dump_file_path: '/tmp/state.xml',
          nodes,
        },
      })),
    };
    const h = await makeHarness(deps, { sessionId: 'android-session-1' });

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'get_device_state',
        args: { device_serial: 'emulator-5554' },
      },
    });

    const content = (result as { content: Array<{ type: string; text?: string; data?: string }> }).content;
    const text = content[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      data: {
        nodes: unknown[];
        nodes_truncated?: boolean;
        raw_ui_dump_file_path?: string;
      };
    };
    expect(Buffer.byteLength(JSON.stringify(content), 'utf8')).toBeLessThanOrEqual(240_000);
    expect(payload.data.nodes_truncated).toBe(true);
    expect(payload.data.raw_ui_dump_file_path).toBe('/tmp/state.xml');
    expect(payload.data.nodes.length).toBeLessThan(nodes.length);
    await h.cleanup();
  });

  it('maps host business errors to MCP error payloads', async () => {
    const deps: AndroidMcpDeps = {
      callTool: vi.fn(async () => ({
        ok: false,
        errorCode: 'NO_DEVICE',
        message: 'No adb device connected',
      })),
    };
    const h = await makeHarness(deps);

    const result = await h.client.callTool({
      name: 'call_tool',
      arguments: {
        name: 'status',
        args: {},
      },
    });
    const payload = textPayload(result) as {
      ok: boolean;
      errorCode: string;
      data: { message: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('NO_DEVICE');
    expect(payload.data.message).toContain('No adb device connected');
    expect((result as { isError?: boolean }).isError).toBe(true);
    await h.cleanup();
  });
});
