// app 变体标记。由 eas.json 的 `beta` build profile 注入 `EXPO_PUBLIC_APP_VARIANT=beta`
// (Metro 在打包/OTA 时把它内联进 JS bundle)。production / 本地开发为 undefined → 'production'。
//
// 用途:`if (IS_BETA) { ... }` 切换"只有 beta 包才有"的行为(调试面板、额外日志等)。
// 它是 JS bundle 层的值,**不进 @expo/fingerprint**,所以 beta 与正式版可共用指纹基线,
// 真正把两者隔开的是 build 时绑定的 channel(beta vs production),各自只收各自轨道的 OTA。
export const APP_VARIANT = process.env.EXPO_PUBLIC_APP_VARIANT ?? 'production';
export const IS_BETA = APP_VARIANT === 'beta';
export const BETA_DEV = process.env.EXPO_PUBLIC_BETA_DEV?.trim() || null;
