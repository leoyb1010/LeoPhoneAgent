import { z } from 'zod';
import type { AndroidMcpErrorCode } from '../types.js';

export type AndroidToolCategory = 'android';

export type AndroidToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface AndroidToolResult {
  content: AndroidToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type AndroidToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<AndroidToolResult>;

export interface AndroidToolDef {
  name: string;
  category: AndroidToolCategory;
  description: string;
  readOnly?: boolean;
  inputShape: z.ZodRawShape;
  handler: AndroidToolHandler;
}

export interface AndroidToolSummary {
  name: string;
  category: AndroidToolCategory;
  description: string;
  readOnly: boolean;
}

export function androidTextResult(
  value: unknown,
  isError = false,
  extra: Partial<AndroidToolResult> = {},
): AndroidToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value),
      },
    ],
    ...(isError ? { isError: true } : {}),
    ...extra,
  };
}

export function androidBusinessError(
  errorCode: AndroidMcpErrorCode,
  message: string,
  data?: Record<string, unknown>,
): AndroidToolResult {
  return androidTextResult(
    {
      ok: false,
      errorCode,
      data: {
        message,
        ...(data ?? {}),
      },
    },
    true,
  );
}

export class AndroidToolRegistry {
  private readonly tools = new Map<string, AndroidToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: AndroidToolCategory;
    description: string;
    readOnly?: boolean;
    inputShape: T;
    handler: AndroidToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[androidToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as AndroidToolDef);
  }

  list(category?: AndroidToolCategory): AndroidToolSummary[] {
    const all: AndroidToolSummary[] = [];
    for (const tool of this.tools.values()) {
      if (category && tool.category !== category) continue;
      all.push({
        name: tool.name,
        category: tool.category,
        description: tool.description,
        readOnly: tool.readOnly === true,
      });
    }
    return all;
  }

  listCategories(): AndroidToolCategory[] {
    const set = new Set<AndroidToolCategory>();
    for (const tool of this.tools.values()) set.add(tool.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<AndroidToolResult> {
    const def = this.tools.get(name);
    if (!def) {
      return androidTextResult(
        {
          ok: false,
          errorCode: 'UNKNOWN_TOOL',
          data: {
            requested: name,
            available: Array.from(this.tools.keys()),
            hint: '调用 list_tools 查看完整工具列表',
          },
        },
        true,
      );
    }

    const objSchema = z.strictObject(def.inputShape);
    const parsed = objSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      let jsonSchema: unknown;
      try {
        jsonSchema = z.toJSONSchema(objSchema);
      } catch {
        jsonSchema = '<schema serialization failed>';
      }
      return androidTextResult(
        {
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: {
            tool: name,
            validation_errors: parsed.error.issues,
            schema: jsonSchema,
            hint: '请按 schema 修正参数后重试',
          },
        },
        true,
      );
    }

    return def.handler(parsed.data as Record<string, unknown>);
  }
}
