/**
 * memory/list.ts — memory_list tool
 *
 * 列出当前 workdir 所有 memory 分片 (含 frontmatter, 不含 body)。
 * 跟看 MEMORY.md 索引功能重叠 — 但 MEMORY.md 是已经拼好的 markdown 字符串,
 * memory_list 返结构化 JSON, LLM 处理大量条目时更精准。
 */

import { withStore } from './_shared.js';
import type { MemoryMcpDeps } from '../types.js';
import type { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';

export function registerMemoryListTool(registry: MemoryToolRegistry, deps: MemoryMcpDeps): void {
  registry.register({
    name: 'memory_list',
    category: 'read',
    description:
      '列出当前 workdir 全部 memory 分片元数据 (filename / type / title / description / updatedAt / sizeBytes)。' +
      ' 按 type → slug 排序, 不含 body。要看 body 走 memory_read。',
    inputShape: {},
    handler: async () =>
      withStore(deps, async (store) => {
        const records = await store.list();
        return records.map((r) => ({
          filename: r.filename,
          type: r.frontmatter.type,
          title: r.frontmatter.title,
          description: r.frontmatter.description,
          updatedAt: r.frontmatter.updatedAt,
          sizeBytes: r.sizeBytes,
        }));
      }),
  });
}
