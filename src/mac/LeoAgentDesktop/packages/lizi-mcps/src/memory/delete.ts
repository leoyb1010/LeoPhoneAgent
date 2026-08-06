/**
 * memory/delete.ts — memory_delete tool
 *
 * 删除单条 memory 分片. 不存在抛 NOT_FOUND. 删完 MEMORY.md 自动重建。
 * 用户主动让 LLM 清理 / review 后清理过期条目时调。
 */

import { z } from 'zod';

import { withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryDeleteTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_delete',
    category: 'write',
    description:
      '删除一条 memory 分片。filename 形如 "user_preferences.md"。删除后 MEMORY.md 自动重建。' +
      ' 不存在返 NOT_FOUND。',
    inputShape: {
      filename: z.string().min(1).describe('memory 分片文件名'),
    },
    handler: async ({ filename }) =>
      withStore(deps, async (store) => {
        await store.delete(filename);
        return { deleted: filename };
      }),
  });
}
