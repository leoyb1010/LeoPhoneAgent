/**
 * DEV-only 性能 harness 数据源(临时,profiling 结束后删)。
 * 生成一批「真实感」的消息(段落 / 代码块 / 表格 / 列表 + 部分 mermaid / math),
 * 经 buildMobileMessageRenderItems 转成正式 render items,喂给真正的 MessageRenderer。
 * 目的:隔离列表渲染性能,不经 auth / device-link / 网络。
 */
import { buildMobileMessageRenderItems, type MobileMessageRenderItem } from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const ts = (s: number): string => new Date(BASE + s * 1000).toISOString();

function assistantBody(i: number, media: boolean): string {
  const head = `## 回答 ${i}\n\n这是第 ${i} 轮的助手回复,包含一段说明文字用来撑起真实的排版高度。段落里有 **加粗**、\`inline code\` 和 [链接](https://example.com) 混排,贴近真实消息形态。`;
  if (media && i % 8 === 0) {
    // 触发 mermaid WebView
    return `${head}\n\n下面是流程图:\n\n\`\`\`mermaid\nflowchart TD\n  A["开始 ${i}"] --> B{"判断"}\n  B -->|"是"| C["分支一"]\n  B -->|"否"| D["分支二"]\n  C --> E["结束"]\n  D --> E\n\`\`\`\n`;
  }
  if (media && i % 10 === 3) {
    // 触发 math WebView
    return `${head}\n\n公式推导:\n\n$$\n\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6} \\quad (i=${i})\n$$\n`;
  }
  if (i % 5 === 2) {
    // 代码块 + 表格
    return `${head}\n\n\`\`\`ts\nfunction step${i}(x: number) {\n  const y = x * ${i} + 1;\n  return y > 0 ? y : -y;\n}\n\`\`\`\n\n| 列A | 列B | 列C |\n|---|---|---|\n| ${i} | ${i * 2} | ${i * 3} |\n| a | b | c |\n`;
  }
  // 列表 + 多段
  return `${head}\n\n要点:\n\n- 第一点 ${i}\n- 第二点,稍微长一些的描述文字用来换行\n- 第三点\n\n结论段落,再补一句收尾。`;
}

export interface ListPerfOptions {
  /** 是否包含 mermaid/math(内嵌 WebView)消息;false 用于隔离 WebView 成本。默认 true。 */
  media?: boolean;
}

/** 生成 turns 轮对话(每轮 1 user + 1 assistant),返回原始 RemoteMessage[]。 */
export function buildListPerfMessages(turns: number, opts: ListPerfOptions = {}): RemoteMessage[] {
  const media = opts.media !== false;
  const out: RemoteMessage[] = [];
  for (let i = 0; i < turns; i++) {
    const offset = i * 5;
    out.push({
      id: `u-${i}`,
      clientId: `u-${i}`,
      sessionId: 'perf-session',
      role: 'user',
      content: { text: `问题 ${i}:帮我处理一下第 ${i} 个任务,给点细节说明。`, images: [], files: [] },
      toolUseId: null,
      agentMeta: null,
      createdAt: ts(offset),
    });
    out.push({
      id: `a-${i}`,
      clientId: `a-${i}`,
      sessionId: 'perf-session',
      role: 'assistant',
      content: { text: assistantBody(i, media) },
      toolUseId: null,
      agentMeta: null,
      createdAt: ts(offset + 2),
    });
  }
  return out;
}

/** 直接拿到可喂给 MessageRenderer 的 render items。 */
export function buildListPerfRenderItems(turns: number, opts: ListPerfOptions = {}): MobileMessageRenderItem[] {
  return buildMobileMessageRenderItems(buildListPerfMessages(turns, opts), { isSessionStreaming: false });
}
