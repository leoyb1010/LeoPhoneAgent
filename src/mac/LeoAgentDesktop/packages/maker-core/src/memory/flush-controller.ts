/**
 * MemoryFlushController — Pre-compaction flush 触发观察器 (A 轻版: 只打日志, 不注入)。
 *
 * 设计背景:
 *  - SDK 自带的 compaction 事件 (Claude `compact_boundary`, Codex `contextCompaction`)
 *    都是 post-fact 信号 (压缩进行中或完成时), 抢救不了被压缩的对话内容。
 *    OpenClaw 的 flush 设计是 pre-compaction (token 接近上限时触发, 让 LLM 抢在
 *    压缩前写 memory) — 唯一可行路径是基于 token usage 阈值倒推。
 *
 *  - token usage 准确度有限 (SDK 报告口径 / context_window 不等于可用空间 /
 *    单 turn 跳跃) → **多档阈值** [0.70, 0.85, 0.92] 提高命中率。
 *
 * 当前阶段 (A 轻版):
 *  - **只打 INFO 日志**, 不注入 silent turn, 不让 LLM 写 memory。
 *  - 目的: 验证 token usage 信号源在真实环境下是否准 — 跑两天看日志:
 *    · 阈值真能被命中吗?
 *    · 命中频率合理吗 (太频繁 / 太稀疏)?
 *    · ratio 跟实际 compaction 时机吻合吗?
 *  - 验证通过后再升级 B 完整版 (silent turn 注入 + NO_REPLY 翻译)。
 *
 * 阈值跨越逻辑:
 *  - 一个 session 内每档阈值只触发一次 (避免重复 flush)
 *  - 收到 compact_boundary 事件后所有 fired 标记清零 (compact 后又有空间)
 *
 * 使用方:
 *  - claude-code agent / codex agent 在 startSession 时按 makerMemoryEnabled 创建实例
 *  - 在 token usage 更新事件后调 onUsageUpdate(used, window)
 *  - 在 compact_boundary 事件后调 onCompactBoundary()
 */

import type { Logger } from '../interfaces/logger.js';

/** 默认阈值 — pre-compaction 三档 (轻警示 / 中期 / 接近上限) */
export const DEFAULT_FLUSH_THRESHOLDS: readonly number[] = [0.7, 0.85, 0.92];

export interface MemoryFlushControllerDeps {
  logger: Logger;
  /** 当前 session 绑定的 workdir (日志 context) */
  workdir: string;
  /** 当前 session 的 agent kind ('claude-code' / 'codex') */
  agentKind: string;
  /** 触发阈值, 按升序; 缺省走 DEFAULT_FLUSH_THRESHOLDS */
  thresholds?: readonly number[];
}

export class MemoryFlushController {
  private readonly thresholds: readonly number[];
  private readonly fired = new Set<number>();

  constructor(private readonly deps: MemoryFlushControllerDeps) {
    const t = (deps.thresholds ?? DEFAULT_FLUSH_THRESHOLDS).slice().sort((a, b) => a - b);
    if (t.some((v) => v <= 0 || v > 1)) {
      throw new Error(`MemoryFlushController: thresholds must be in (0, 1], got ${JSON.stringify(t)}`);
    }
    this.thresholds = Object.freeze(t);
  }

  /**
   * 每次 SDK token usage 更新时调. 内部计算 ratio = used / window, 跨过任一未 fired
   * 档位 → 打 INFO 日志 + 标记该档 fired (本 session 内不再重复触发同档)。
   *
   * window <= 0 (SDK 没报) 或 used < 0 直接 no-op, 不依赖估算。
   */
  onUsageUpdate(contextTokens: number, contextWindow: number): void {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
    if (!Number.isFinite(contextTokens) || contextTokens < 0) return;
    const ratio = contextTokens / contextWindow;
    for (const t of this.thresholds) {
      if (ratio >= t && !this.fired.has(t)) {
        this.fired.add(t);
        this.deps.logger.debug('memory flush window crossed (A: log only)', {
          threshold: t,
          ratio: Number(ratio.toFixed(3)),
          contextTokens,
          contextWindow,
          workdir: this.deps.workdir,
          agentKind: this.deps.agentKind,
          remainingTokens: contextWindow - contextTokens,
          firedSoFar: Array.from(this.fired).sort(),
        });
      }
    }
  }

  /**
   * compact_boundary 事件后调 — 重置所有 fired 标记 (compact 把 context 空出来了,
   * 下次再涨上去时可以重新触发各档)。无 fired 时 no-op。
   */
  onCompactBoundary(): void {
    if (this.fired.size === 0) return;
    const prev = Array.from(this.fired).sort();
    this.fired.clear();
    this.deps.logger.debug('memory flush thresholds reset (compact_boundary)', {
      prevFired: prev,
      workdir: this.deps.workdir,
      agentKind: this.deps.agentKind,
    });
  }

  /** 当前已 fired 的档位 (调试 / 测试用) */
  getFiredThresholds(): number[] {
    return Array.from(this.fired).sort();
  }
}
