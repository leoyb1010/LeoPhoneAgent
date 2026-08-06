/**
 * error-tail-banner:mergeDismissedIntoErrorContent 纯函数单测(规则 14)。
 * dismiss-error IPC 的业务体 —— 保证「忽略」错误行时原字段不丢、异常输入不炸。
 */

import { describe, expect, it } from 'vitest';
import { mergeDismissedIntoErrorContent } from '../../shared/interruptedTurn.js';

describe('mergeDismissedIntoErrorContent', () => {
  it('preserves all original fields and adds dismissed on a JSON object', () => {
    const raw = JSON.stringify({
      message: 'Claude Code process exited with code 143',
      reason: 'turn-failed',
      sdkError: 'process_exited',
    });
    expect(mergeDismissedIntoErrorContent(raw)).toEqual({
      message: 'Claude Code process exited with code 143',
      reason: 'turn-failed',
      sdkError: 'process_exited',
      dismissed: true,
    });
  });

  it('is idempotent', () => {
    const once = mergeDismissedIntoErrorContent(JSON.stringify({ message: 'x' }));
    const twice = mergeDismissedIntoErrorContent(JSON.stringify(once));
    expect(twice).toEqual(once);
  });

  it('wraps non-object JSON and invalid JSON without losing the original text', () => {
    expect(mergeDismissedIntoErrorContent('"plain string"')).toEqual({
      message: '"plain string"',
      dismissed: true,
    });
    expect(mergeDismissedIntoErrorContent('[1,2]')).toEqual({
      message: '[1,2]',
      dismissed: true,
    });
    expect(mergeDismissedIntoErrorContent('not-json {')).toEqual({
      message: 'not-json {',
      dismissed: true,
    });
  });
});
