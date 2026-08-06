import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedVisualLineThreshold,
  shouldAutoCollapseUserMessageContent,
} from '@/components/chat/userMessageCollapse';

const userMessageSource = readFileSync(
  path.resolve(__dirname, '../components/chat/UserMessage.tsx'),
  'utf8',
);

describe('shouldAutoCollapseUserMessageContent (首帧估算)', () => {
  it('keeps short user messages expanded by default', () => {
    expect(shouldAutoCollapseUserMessageContent('帮我看一下最近的日志')).toBe(false);
    expect(shouldAutoCollapseUserMessageContent('   ')).toBe(false);
  });

  it('keeps a moderate CJK paragraph expanded', () => {
    // 200 个全宽字符 ≈ 400 半宽单位 ≈ 7 个视觉行,不应收起。
    expect(shouldAutoCollapseUserMessageContent('改'.repeat(200))).toBe(false);
  });

  it('collapses content after the visual line threshold (short lines count as one each)', () => {
    const thresholdLines = Array.from(
      { length: LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD },
      (_, index) => `line ${index + 1}`,
    ).join('\n');
    const extraLine = `${thresholdLines}\nline ${LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD + 1}`;

    expect(shouldAutoCollapseUserMessageContent(thresholdLines)).toBe(false);
    expect(shouldAutoCollapseUserMessageContent(extraLine)).toBe(true);
  });

  it('collapses long single-paragraph latin prompts that would wrap in the bubble', () => {
    // 60 半宽单位/视觉行 → 840 字符恰好 14 行(不收起),841 字符进第 15 行(收起)。
    expect(shouldAutoCollapseUserMessageContent('x'.repeat(840))).toBe(false);
    expect(shouldAutoCollapseUserMessageContent('x'.repeat(841))).toBe(true);
  });

  it('collapses CJK-dense prompts with few newlines (scheduler heartbeat regression)', () => {
    // 回归:心跳任务 prompt ~1248 字符 / 9 个逻辑行,最早的逻辑(只数换行符 +
    // 1260 字符阈值)两个条件都差一点不命中,视觉上却有 40+ 行。
    const lines = Array.from(
      { length: 9 },
      (_, index) => `${index + 1}. ${'按规则处理并回复'.repeat(16)}`,
    ).join('\n');

    expect(lines.split('\n').length).toBeLessThan(LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD);
    expect(shouldAutoCollapseUserMessageContent(lines)).toBe(true);
  });
});

describe('自动化任务消息的更低阈值', () => {
  it('collapses automation prompts that a hand-typed message would keep expanded', () => {
    // 6 个短逻辑行:手打消息(14 行阈值)不收起,自动任务(4 行阈值)收起。
    const sixLines = Array.from({ length: 6 }, (_, index) => `step ${index + 1}`).join('\n');

    expect(shouldAutoCollapseUserMessageContent(sixLines)).toBe(false);
    expect(
      shouldAutoCollapseUserMessageContent(sixLines, AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD),
    ).toBe(true);
    expect(mayExceedVisualLineThreshold(sixLines)).toBe(false);
    expect(
      mayExceedVisualLineThreshold(sixLines, AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD),
    ).toBe(true);
  });

  it('keeps short automation prompts expanded (threshold lines exactly)', () => {
    const thresholdLines = Array.from(
      { length: AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD },
      (_, index) => `step ${index + 1}`,
    ).join('\n');

    expect(
      shouldAutoCollapseUserMessageContent(thresholdLines, AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD),
    ).toBe(false);
  });

  it('automation threshold stays strictly below the hand-typed threshold', () => {
    expect(AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD).toBeLessThan(
      LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
    );
  });
});

describe('mayExceedVisualLineThreshold (镜像测量粗筛)', () => {
  it('skips measurement for content that cannot reach the threshold at any bubble width', () => {
    expect(mayExceedVisualLineThreshold('')).toBe(false);
    expect(mayExceedVisualLineThreshold('帮我看一下最近的日志')).toBe(false);
    // 1 逻辑行 + 2×100/24 ≈ 9 < 14,按最窄气泡折算也排不满。
    expect(mayExceedVisualLineThreshold('x'.repeat(100))).toBe(false);
  });

  it('keeps measuring candidates that only overflow when the bubble is narrow (review P2 regression)', () => {
    // 200 个全宽字符在名义 456px 宽度下约 7 个视觉行(估算不收起),但气泡被
    // 窗口 / 侧栏压窄到 ~200px 时会超过 14 行——粗筛必须放行让镜像实测决定,
    // 否则测量节点不存在,resize 后也永远收不起来。
    const narrowOnlyCandidate = '改'.repeat(200);
    expect(shouldAutoCollapseUserMessageContent(narrowOnlyCandidate)).toBe(false);
    expect(mayExceedVisualLineThreshold(narrowOnlyCandidate)).toBe(true);
  });

  it('is an upper bound: never skips content the estimator would collapse', () => {
    const samples = [
      'x'.repeat(841),
      '改'.repeat(450),
      Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n'),
      Array.from({ length: 9 }, () => '按规则处理并回复'.repeat(16)).join('\n'),
    ];
    for (const sample of samples) {
      expect(shouldAutoCollapseUserMessageContent(sample)).toBe(true);
      expect(mayExceedVisualLineThreshold(sample)).toBe(true);
    }
  });
});

describe('UserMessage 收起判定接线', () => {
  it('uses the measurement hook with a mirror node for real layout-based collapse', () => {
    expect(userMessageSource).toContain('useUserMessageAutoCollapse');
    expect(userMessageSource).toContain('mayExceedVisualLineThreshold');
    expect(userMessageSource).toContain('collapseMirrorRef');
  });

  it('uses the shared Tailwind line-clamp utility for collapsed rendering', () => {
    expect(userMessageSource).toContain('line-clamp-10');
    expect(userMessageSource).not.toContain('WebkitLineClamp');
    expect(userMessageSource).not.toContain('[display:-webkit-box]');
  });

  it('renders automation-origin messages with the tighter clamp and threshold', () => {
    expect(userMessageSource).toContain('AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD');
    expect(userMessageSource).toContain('line-clamp-3');
  });
});
