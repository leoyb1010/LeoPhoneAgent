/**
 * Contract tests for Plugin detail description normalization.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { describe, expect, it } from 'vitest';

import { ghostPluginSummary } from '../../features/plugin/lib/ghostPluginDetailModel';

describe('ghostPluginDetailModel', () => {
  it('preserves the complete normalized description', () => {
    expect(ghostPluginSummary('Generate images. Includes editing and export.', 'xd-mivo')).toBe(
      'Generate images. Includes editing and export.',
    );
    expect(ghostPluginSummary('生成图片、视频和音乐。支持更多高级设置。', 'xd-mivo')).toBe(
      '生成图片、视频和音乐。支持更多高级设置。',
    );
    expect(
      ghostPluginSummary('访问  aigc.example.com\n生成图片。支持更多高级设置。', 'xd-mivo'),
    ).toBe('访问 aigc.example.com 生成图片。支持更多高级设置。');
    expect(ghostPluginSummary('   ', 'xd-mivo')).toBe('xd-mivo');
  });
});
