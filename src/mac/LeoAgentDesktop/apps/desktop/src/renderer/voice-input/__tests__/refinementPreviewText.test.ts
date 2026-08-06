import { describe, expect, it } from 'vitest';

import { buildRefinementPreviewText } from '../refinementPreviewText';

describe('buildRefinementPreviewText', () => {
  it('preserves the raw suffix while the streaming preview is shorter', () => {
    expect(buildRefinementPreviewText('嗯那个我们今天先不要提交', '我们今天')).toBe('我们今天们今天先不要提交');
  });

  it('uses the preview directly after it reaches the raw text length', () => {
    expect(buildRefinementPreviewText('今天测试', '今天测试语音输入')).toBe('今天测试语音输入');
  });

  it('keeps the raw text visible when preview is empty', () => {
    expect(buildRefinementPreviewText('今天测试', '')).toBe('今天测试');
  });
});
