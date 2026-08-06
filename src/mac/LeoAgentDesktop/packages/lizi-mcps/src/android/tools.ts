import { z } from 'zod';
import sharp from 'sharp';
import {
  INLINE_IMAGE_TARGET_BYTES,
  type AndroidDeviceStateResult,
  type AndroidConnectedDevice,
  type AndroidUiNode,
  type AndroidMcpCallContext,
  type AndroidMcpDeps,
  type AndroidMcpErrorCode,
  type AndroidMcpToolName,
  type AndroidStatusSummary,
} from '../types.js';
import {
  androidBusinessError,
  androidTextResult,
  type AndroidToolRegistry,
} from './tool-registry.js';

const CATEGORY = 'android' as const;
const MAX_STATE_TEXT_BYTES = INLINE_IMAGE_TARGET_BYTES;
const MAX_TOOL_RESULT_STREAM_BYTES = 240_000;
const TOOL_RESULT_ENVELOPE_BYTES = 4_096;
const MAX_NODE_STRING_CHARS = 160;
const INLINE_SCREENSHOT_SIDES = [1280, 1024, 800, 640, 480, 360, 240] as const;
const INLINE_SCREENSHOT_QUALITIES = [72, 60, 48, 36, 28, 20] as const;
type InlineScreenshot = {
  data: string;
  mimeType: AndroidDeviceStateResult['screenshot_mime_type'] | 'image/jpeg';
};
type AndroidStatePayload = {
  ok: true;
  data: {
    device_serial: string;
    screen: AndroidDeviceStateResult['screen'];
    current_app: AndroidDeviceStateResult['current_app'];
    screenshot_file_path: string;
    nodes: AndroidUiNode[];
    nodes_truncated?: true;
    raw_ui_dump_file_path?: string;
    ui_dump_error?: string;
  };
};

const DEVICE_SERIAL = z.string().min(1).optional().describe('可选 device serial。多设备连接时必须显式传。');

function isBusinessError(result: unknown): result is {
  ok: false;
  errorCode: AndroidMcpErrorCode;
  message?: string;
  data?: Record<string, unknown>;
} {
  return !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === false
    && typeof (result as { errorCode?: unknown }).errorCode === 'string';
}

function coerceSuccess<T>(tool: AndroidMcpToolName, result: unknown): T {
  if (!result || typeof result !== 'object') {
    throw new Error(`android:${tool}: invalid host result`);
  }
  const value = result as { ok?: unknown; data?: unknown };
  if (value.ok !== true) {
    throw new Error(`android:${tool}: host result was not ok`);
  }
  return value.data as T;
}

async function callAndroidTool<T>(
  deps: AndroidMcpDeps,
  name: AndroidMcpToolName,
  args: Record<string, unknown>,
  context?: AndroidMcpCallContext,
): Promise<T> {
  const result = await deps.callTool(name, args, context);
  if (isBusinessError(result)) {
    throw result;
  }
  return coerceSuccess<T>(name, result);
}

function toErrorResult(err: unknown) {
  if (isBusinessError(err)) {
    return androidBusinessError(
      err.errorCode,
      err.message ?? 'Android MCP host call failed',
      err.data,
    );
  }
  return androidBusinessError(
    'ANDROID_DRIVER_ERROR',
    err instanceof Error ? err.message : String(err),
  );
}

async function compressInlineScreenshot(data: AndroidDeviceStateResult): Promise<InlineScreenshot> {
  const original = Buffer.from(data.screenshot_base64, 'base64');
  if (original.byteLength <= INLINE_IMAGE_TARGET_BYTES) {
    return { data: data.screenshot_base64, mimeType: data.screenshot_mime_type };
  }

  let smallest: Buffer | null = null;
  for (const side of INLINE_SCREENSHOT_SIDES) {
    for (const quality of INLINE_SCREENSHOT_QUALITIES) {
      const resized = await sharp(original, { failOn: 'none' })
        .rotate()
        .resize({
          width: side,
          height: side,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality })
        .toBuffer();
      if (!smallest || resized.byteLength < smallest.byteLength) {
        smallest = resized;
      }
      if (resized.byteLength <= INLINE_IMAGE_TARGET_BYTES) {
        return { data: resized.toString('base64'), mimeType: 'image/jpeg' };
      }
    }
  }

  if (smallest) {
    return { data: smallest.toString('base64'), mimeType: 'image/jpeg' };
  }
  return { data: data.screenshot_base64, mimeType: data.screenshot_mime_type };
}

function truncateNodeString(value: string | undefined): {
  value: string | undefined;
  truncated: boolean;
} {
  if (!value || value.length <= MAX_NODE_STRING_CHARS) {
    return { value, truncated: false };
  }
  return {
    value: `${value.slice(0, MAX_NODE_STRING_CHARS)}...`,
    truncated: true,
  };
}

function compactUiNode(node: AndroidUiNode): { node: AndroidUiNode; truncated: boolean } {
  const text = truncateNodeString(node.text);
  const contentDesc = truncateNodeString(node.content_desc);
  const resourceId = truncateNodeString(node.resource_id);
  const className = truncateNodeString(node.class_name);
  const packageName = truncateNodeString(node.package);
  return {
    node: {
      ...node,
      ...(text.value !== undefined ? { text: text.value } : {}),
      ...(contentDesc.value !== undefined ? { content_desc: contentDesc.value } : {}),
      ...(resourceId.value !== undefined ? { resource_id: resourceId.value } : {}),
      ...(className.value !== undefined ? { class_name: className.value } : {}),
      ...(packageName.value !== undefined ? { package: packageName.value } : {}),
    },
    truncated: text.truncated
      || contentDesc.truncated
      || resourceId.truncated
      || className.truncated
      || packageName.truncated,
  };
}

function buildStatePayload(
  data: AndroidDeviceStateResult,
  nodes: AndroidUiNode[],
  nodesTruncated: boolean,
): AndroidStatePayload {
  return {
    ok: true,
    data: {
      device_serial: data.device_serial,
      screen: data.screen,
      current_app: data.current_app,
      screenshot_file_path: data.screenshot_file_path,
      nodes,
      ...(nodesTruncated ? { nodes_truncated: true } : {}),
      ...(data.raw_ui_dump_file_path ? { raw_ui_dump_file_path: data.raw_ui_dump_file_path } : {}),
      ...(data.ui_dump_error ? { ui_dump_error: data.ui_dump_error } : {}),
    },
  };
}

function payloadBytes(payload: AndroidStatePayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function buildBoundedStatePayload(
  data: AndroidDeviceStateResult,
  maxTextBytes = MAX_STATE_TEXT_BYTES,
): AndroidStatePayload {
  const compacted = data.nodes.map(compactUiNode);
  const compactNodes = compacted.map((item) => item.node);
  const stringTruncated = compacted.some((item) => item.truncated);
  const baseTruncated = Boolean(data.nodes_truncated || stringTruncated);
  const fullPayload = buildStatePayload(data, compactNodes, baseTruncated);
  if (payloadBytes(fullPayload) <= maxTextBytes) {
    return fullPayload;
  }

  let low = 0;
  let high = compactNodes.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = buildStatePayload(data, compactNodes.slice(0, mid), true);
    if (payloadBytes(candidate) <= maxTextBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return buildStatePayload(data, compactNodes.slice(0, best), true);
}

function stateTextBudgetFor(inlineScreenshot: InlineScreenshot): number {
  const imageBlockBytes = Buffer.byteLength(inlineScreenshot.data, 'utf8')
    + Buffer.byteLength(inlineScreenshot.mimeType, 'utf8');
  return Math.max(
    0,
    Math.min(
      MAX_STATE_TEXT_BYTES,
      MAX_TOOL_RESULT_STREAM_BYTES - TOOL_RESULT_ENVELOPE_BYTES - imageBlockBytes,
    ),
  );
}

async function stateResult(data: AndroidDeviceStateResult) {
  let inlineScreenshot: InlineScreenshot = {
    data: data.screenshot_base64,
    mimeType: data.screenshot_mime_type,
  };
  try {
    inlineScreenshot = await compressInlineScreenshot(data);
  } catch {
    inlineScreenshot = { data: data.screenshot_base64, mimeType: data.screenshot_mime_type };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(buildBoundedStatePayload(data, stateTextBudgetFor(inlineScreenshot))),
      },
      {
        type: 'image' as const,
        data: inlineScreenshot.data,
        mimeType: inlineScreenshot.mimeType,
      },
    ],
  };
}

const pointSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

export function registerAndroidTools(
  registry: AndroidToolRegistry,
  deps: AndroidMcpDeps,
  getContext?: () => AndroidMcpCallContext | undefined,
): void {
  registry.register({
    name: 'status',
    category: CATEGORY,
    description: 'Check whether adb is installed and summarize current Android device availability.',
    readOnly: true,
    inputShape: {},
    handler: async () => {
      try {
        const data = await callAndroidTool<AndroidStatusSummary>(deps, 'status', {}, getContext?.());
        return androidTextResult({ ok: true, data });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

  registry.register({
    name: 'list_devices',
    category: CATEGORY,
    description: 'List all adb-visible Android devices and emulators with their current states.',
    readOnly: true,
    inputShape: {},
    handler: async () => {
      try {
        const data = await callAndroidTool<AndroidConnectedDevice[]>(deps, 'list_devices', {}, getContext?.());
        return androidTextResult({ ok: true, data });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

  registry.register({
    name: 'get_device_state',
    category: CATEGORY,
    description: 'Capture a screenshot, current app, screen size, and compact UI node list for one Android device.',
    readOnly: true,
    inputShape: {
      device_serial: DEVICE_SERIAL,
    },
    handler: async (args) => {
      try {
        const data = await callAndroidTool<AndroidDeviceStateResult>(
          deps,
          'get_device_state',
          args as Record<string, unknown>,
          getContext?.(),
        );
        return await stateResult(data);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

  registry.register({
    name: 'tap',
    category: CATEGORY,
    description: 'Tap by element_index from the latest device snapshot or by absolute screen coordinates.',
    inputShape: {
      device_serial: DEVICE_SERIAL,
      element_index: z.number().int().nonnegative().optional(),
      x: z.number().int().nonnegative().optional(),
      y: z.number().int().nonnegative().optional(),
    },
    handler: async (args) => {
      try {
        const data = await callAndroidTool<Record<string, unknown>>(deps, 'tap', args as Record<string, unknown>, getContext?.());
        return androidTextResult({ ok: true, data });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

  registry.register({
    name: 'swipe',
    category: CATEGORY,
    description: 'Swipe between absolute screen coordinates on one Android device.',
    inputShape: {
      device_serial: DEVICE_SERIAL,
      start: pointSchema,
      end: pointSchema,
      duration_ms: z.number().int().min(0).max(60_000).optional(),
    },
    handler: async (args) => {
      try {
        const data = await callAndroidTool<Record<string, unknown>>(deps, 'swipe', args as Record<string, unknown>, getContext?.());
        return androidTextResult({ ok: true, data });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

  registry.register({
    name: 'input_text',
    category: CATEGORY,
    description: 'Input plain text into the currently focused Android field using adb shell input text.',
    inputShape: {
      device_serial: DEVICE_SERIAL,
      text: z.string().min(1),
    },
    handler: async (args) => {
      try {
        const data = await callAndroidTool<Record<string, unknown>>(deps, 'input_text', args as Record<string, unknown>, getContext?.());
        return androidTextResult({ ok: true, data });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

  registry.register({
    name: 'press_key',
    category: CATEGORY,
    description: 'Send one Android keyevent such as BACK, HOME, ENTER, or APP_SWITCH.',
    inputShape: {
      device_serial: DEVICE_SERIAL,
      key: z.enum(['BACK', 'HOME', 'ENTER', 'APP_SWITCH', 'POWER', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER']),
    },
    handler: async (args) => {
      try {
        const data = await callAndroidTool<Record<string, unknown>>(deps, 'press_key', args as Record<string, unknown>, getContext?.());
        return androidTextResult({ ok: true, data });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });

  registry.register({
    name: 'launch_app',
    category: CATEGORY,
    description: 'Launch an Android app by package name and optional activity. Arbitrary intents are not supported.',
    inputShape: {
      device_serial: DEVICE_SERIAL,
      package: z.string().min(1),
      activity: z.string().min(1).optional(),
    },
    handler: async (args) => {
      try {
        const data = await callAndroidTool<Record<string, unknown>>(deps, 'launch_app', args as Record<string, unknown>, getContext?.());
        return androidTextResult({ ok: true, data });
      } catch (err) {
        return toErrorResult(err);
      }
    },
  });
}
