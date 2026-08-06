import { Platform } from 'react-native';

/**
 * 统一的等宽字体 —— JetBrains Mono(OFL 开源,随包分发,license 见 assets/fonts/JetBrainsMono-OFL.txt)。
 * 通过 app.json 的 expo-font config plugin 打进 iOS / Android 原生资源,两端 family 名一致,
 * 启动即可用、零闪换;字体文件属于原生资源 → 改动它们是 fingerprint 变更,必须冷更出包。
 *
 * 单独成文件(依赖 react-native 的 Platform),避免 `tokens.ts` 被 RN 污染、
 * 保持其可在 node 单测里直接 import。消费方从 `@/theme` barrel 取 `monoFont`。
 * web(Expo web smoke)没有打包字体,回落系统 monospace。
 */
export const monoFont = Platform.select({
  ios: 'JetBrains Mono',
  android: 'JetBrains Mono',
  default: 'monospace',
}) as string;
