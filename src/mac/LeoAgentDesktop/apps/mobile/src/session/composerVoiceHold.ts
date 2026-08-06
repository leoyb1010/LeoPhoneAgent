import type { MobileVoiceState } from '@/session/mobileVoiceInput';

/**
 * 「语音结束保持展开」hold 的纯函数模型。
 *
 * 背景:composer 卡片态由「聚焦 / 面板打开 / 语音忙碌」驱动,语音结束的瞬间
 * voiceIsBusy 归零,若输入框未聚焦,卡片会立刻塌回单行简洁态——刚说完的
 * 内容被折叠起来。hold 让语音真实收尾(busy → done/error)后、草稿仍有内容
 * 时卡片继续保持展开(一行文字也不收);用户下拉收起 / 失焦 / 草稿清空时解除。
 */

/** 语音 run 占用 composer 的忙碌段(听写中 / 转写中 / 润色中),期间卡片态强制展开。 */
export function isMobileVoiceBusyState(state: MobileVoiceState): boolean {
  return state === 'listening' || state === 'submitting' || state === 'refining';
}

/**
 * 语音态迁移是否应布防 hold:只认从忙碌段落到 done / error 的真实收尾。
 * 启动失败(idle → error)不算——那次 run 从未展开过卡片,布防会让卡片在
 * 报错时凭空弹开;设备切换取消(listening → idle)也不算,取消即放弃收尾。
 */
export function shouldArmComposerVoiceHold(
  previous: MobileVoiceState,
  next: MobileVoiceState,
): boolean {
  if (!isMobileVoiceBusyState(previous)) return false;
  return next === 'done' || next === 'error';
}

/**
 * hold 布防后是否实际保持卡片展开:只要草稿仍有内容就 hold,一行文字也不收
 * (刚说完的内容留在展开态里等用户过目 / 补充 / 发送);草稿清空后没有可看
 * 的内容,回到简洁态。基于 live 草稿持续判定而非收尾一刻的快照——润色替换
 * 文本落地晚于 done 事件,快照会拿到中间态。
 */
export function resolveComposerVoiceHoldActive(input: {
  armed: boolean;
  draftText: string;
}): boolean {
  return input.armed && input.draftText.length > 0;
}
