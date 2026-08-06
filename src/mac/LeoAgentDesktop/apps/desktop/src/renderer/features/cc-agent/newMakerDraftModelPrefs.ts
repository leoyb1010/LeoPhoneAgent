import type { Effort } from '@/lib/userPreferences.types';

/**
 * 首页新建对话没有运行中的模型设置需要保护:只要全局模型预设存在,当前显示的模型也应采用它。
 * 预设仍要按当前来源提供的 effort 档位校验;来源不支持时回落模型默认,目录尚未就绪时保留
 * 草稿原值以避免首帧跳变。
 */
export function resolveNewMakerDraftEffort(args: {
  currentEffort: Effort;
  presetEffort?: Effort;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
}): Effort {
  const { currentEffort, presetEffort, efforts, defaultEffort } = args;
  if (!presetEffort || efforts.length === 0) return currentEffort;
  if (efforts.includes(presetEffort)) return presetEffort;
  if (defaultEffort && efforts.includes(defaultEffort)) return defaultEffort;
  return efforts[0] ?? currentEffort;
}
