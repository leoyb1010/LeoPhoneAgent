import { describe, expect, it } from 'vitest';
import {
  isMobileVoiceBusyState,
  resolveComposerVoiceHoldActive,
  shouldArmComposerVoiceHold,
} from '@/session/composerVoiceHold';

describe('isMobileVoiceBusyState', () => {
  it('听写 / 转写 / 润色为忙碌段', () => {
    expect(isMobileVoiceBusyState('listening')).toBe(true);
    expect(isMobileVoiceBusyState('submitting')).toBe(true);
    expect(isMobileVoiceBusyState('refining')).toBe(true);
  });

  it('idle / done / error 不是忙碌段', () => {
    expect(isMobileVoiceBusyState('idle')).toBe(false);
    expect(isMobileVoiceBusyState('done')).toBe(false);
    expect(isMobileVoiceBusyState('error')).toBe(false);
  });
});

describe('shouldArmComposerVoiceHold', () => {
  it('忙碌段收尾到 done / error 时布防', () => {
    expect(shouldArmComposerVoiceHold('submitting', 'done')).toBe(true);
    expect(shouldArmComposerVoiceHold('refining', 'done')).toBe(true);
    expect(shouldArmComposerVoiceHold('listening', 'error')).toBe(true);
    expect(shouldArmComposerVoiceHold('submitting', 'error')).toBe(true);
  });

  it('启动失败(idle → error)不布防:那次 run 从未展开过卡片', () => {
    expect(shouldArmComposerVoiceHold('idle', 'error')).toBe(false);
    expect(shouldArmComposerVoiceHold('done', 'error')).toBe(false);
    expect(shouldArmComposerVoiceHold('error', 'error')).toBe(false);
  });

  it('取消(listening → idle)与忙碌段内部迁移不布防', () => {
    expect(shouldArmComposerVoiceHold('listening', 'idle')).toBe(false);
    expect(shouldArmComposerVoiceHold('listening', 'submitting')).toBe(false);
    expect(shouldArmComposerVoiceHold('submitting', 'refining')).toBe(false);
  });
});

describe('resolveComposerVoiceHoldActive', () => {
  it('未布防时恒不 hold', () => {
    expect(resolveComposerVoiceHoldActive({ armed: false, draftText: '多行\n内容' })).toBe(false);
  });

  it('单行内容同样 hold(语音结束不回到单行)', () => {
    expect(resolveComposerVoiceHoldActive({ armed: true, draftText: '一句话' })).toBe(true);
  });

  it('多行内容 hold', () => {
    expect(resolveComposerVoiceHoldActive({ armed: true, draftText: '第一行\n第二行' })).toBe(true);
  });

  it('空草稿不 hold(没有可看的内容,回简洁态)', () => {
    expect(resolveComposerVoiceHoldActive({ armed: true, draftText: '' })).toBe(false);
  });
});
