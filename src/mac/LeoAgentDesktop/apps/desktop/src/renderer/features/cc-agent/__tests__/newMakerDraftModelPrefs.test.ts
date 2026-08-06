import { describe, expect, it } from 'vitest';

import { resolveNewMakerDraftEffort } from '../newMakerDraftModelPrefs';

describe('resolveNewMakerDraftEffort', () => {
  it('首页当前显示模型也采用其它对话写入的全局预设', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        presetEffort: 'high',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      }),
    ).toBe('high');
  });

  it('预设不被当前来源支持时回落模型默认', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'low',
        presetEffort: 'xhigh',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      }),
    ).toBe('high');
  });

  it('没有全局预设或目录尚未就绪时保留草稿原值', () => {
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      }),
    ).toBe('medium');
    expect(
      resolveNewMakerDraftEffort({
        currentEffort: 'medium',
        presetEffort: 'high',
        efforts: [],
        defaultEffort: null,
      }),
    ).toBe('medium');
  });
});
