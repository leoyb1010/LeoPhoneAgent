import { promises as fsp } from "node:fs";

import type { ZCodePersistedMessage } from "@zcode/shared";

import type { AutomationRunCompleted } from "./automationEvents.js";
import { writeDurableJson } from "./durableJson.js";

/**
 * [up-c-mac] 自动化运行的结果摘要(docs/specs/leo-link-automations.md「运行结果摘要」)。
 * 只取这次运行最后一条助手回复的正文(最后一次工具调用之后的那段),不碰工具输出。
 */
export const RESULT_SUMMARY_MAX = 280;
const SUCCEEDED_FALLBACK = "已在 Mac 上跑完";
const STOPPED = "运行被停止";
const FAILED_FALLBACK = "运行失败";
/** 记住最近这么多次运行的摘要(按运行 id);更早的手机上也翻不到了。 */
const RESULT_LIMIT = 200;

/** 去 markdown 标记、压空白,超长截断并以「…」收尾(总长 ≤ max,按字符不按 UTF-16)。 */
export function plainSummary(text: string, max = RESULT_SUMMARY_MAX): string {
  const plain = text
    .replace(/```[^\n]*\n?/g, " ") // 代码围栏标记(保留里面的字)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接 → 文字
    .replace(/<\/?[A-Za-z][^>]*>/g, " ") // HTML 标签
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "") // 标题 / 引用 / 列表标记
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ") // 分隔线
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2") // 粗体 / 删除线
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2") // 斜体 *x*(不动 a*b)
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2") // 斜体 _x_(不动 snake_case)
    .replace(/`([^`]*)`/g, "$1") // 行内代码
    .replace(/\|/g, " ") // 表格竖线
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  return chars.length <= max
    ? plain
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/**
 * 这次运行的最终回复:最后一条消息是助手的才算(最后是用户消息 = 还没回复 → null)。
 * 取它最后一次工具调用之后的正文;那段为空就取最后一段正文;没有分段信息再用整条 content。
 */
export function finalReplyText(messages: readonly ZCodePersistedMessage[]): string | null {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") return null;
  const parts = message.parts ?? [];
  if (!parts.length) return message.content.trim() || null;
  const texts = (from: number) =>
    parts
      .slice(from)
      .flatMap((part) =>
        part.type === "content" && part.content.trim() ? [part.content.trim()] : [],
      );
  const lastTool = parts.map((part) => part.type).lastIndexOf("tool-call");
  return texts(lastTool + 1).join("\n") || texts(0).at(-1) || null;
}

/** 推送和 last_run 里的 summary:成功 = 最终回复摘要;失败 = 错误原因(≤280);停止 = 固定文案。 */
export function runSummary(
  outcome: AutomationRunCompleted["outcome"],
  error: string | undefined,
  reply: string | null,
): string {
  if (outcome === "succeeded") return reply ? plainSummary(reply) : SUCCEEDED_FALLBACK;
  if (outcome === "stopped") return STOPPED;
  return plainSummary(error?.trim() || FAILED_FALLBACK);
}

/**
 * 运行 id → 摘要。只是派生结果的缓存(运行记录的所有者仍是自动化服务):
 * 运行结束时会话还活着,读最终回复很便宜;事后再读要冷恢复会话,所以算一次就记下来。
 */
export class AutomationResults {
  private entries = new Map<string, string>();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null) {}

  private load(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.file) return;
      try {
        const parsed = JSON.parse(await fsp.readFile(this.file, "utf8")) as unknown;
        if (!Array.isArray(parsed)) return;
        for (const row of parsed) {
          if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string")
            this.entries.set(row[0], row[1]);
        }
      } catch {
        // 没有或坏了就当没记过:摘要只是锦上添花。
      }
    })();
    return this.loading;
  }

  async get(runId: string): Promise<string | undefined> {
    await this.load();
    return this.entries.get(runId);
  }

  async set(runId: string, summary: string): Promise<void> {
    await this.load();
    this.entries.delete(runId);
    this.entries.set(runId, summary);
    while (this.entries.size > RESULT_LIMIT) this.entries.delete(this.entries.keys().next().value!);
    if (!this.file) return;
    const file = this.file;
    const rows = [...this.entries];
    // 串行写:同一个临时文件,并发 rename 会互相踩掉。
    this.writing = this.writing.catch(() => undefined).then(() => writeDurableJson(file, rows));
    await this.writing;
  }
}
