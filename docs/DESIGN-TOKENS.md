# LeoPhoneAgent 设计 token（四端对照）

T2.5 唯一强调色：青绿。警告色、品牌色（如 xAI 橙）不改。

| 端 | 浅色强调 | 深色强调 | 出处 |
|---|---|---|---|
| Android | `#2E8B8B` | `#4DD9D9` | `src/android/.../ui/theme/Theme.kt` |
| iOS | `#2A8282` | `#2E9C9C` | `Assets.xcassets/AccentColor` → `LeoTheme.ColorToken.accent`（`ChatColors` 只转发） |
| Mac | HSL `175 77% 26%` | HSL `158 84% 64%` | `src/mac/leocodebox/src/styles/tokens.css` |
| Harmony | `#2E8B8B` | `#4DD9D9` | `src/harmony/.../theme/Tokens.ets` |

设置四组（各端同一顺序、同一用词）：我的设备 / Agent / 外观与通用 / 数据与关于。

iOS 青绿比 Android 略深：浅色下白字 ≥ 4.5:1、深色下白色图标 ≥ 3:1，青绿文字在纯黑底 ≥ 4.5:1。

## iOS 组件（F · UI 统一）

| 用途 | 组件 | 位置 |
|---|---|---|
| 输入栏外壳（首页 / 对话 / Paperclip） | `leoComposerChrome()`、`LeoComposerSendButton`，圆角 `LeoTheme.Radius.composer` = 26 | `src/ios/Views/Components/LeoComposerChrome.swift` |
| 空状态 | `LeoEmptyState` | `src/ios/Views/Components/LeoEmptyState.swift` |
| 行内报错 + 重试 | `LeoInlineError` | `src/ios/Views/Components/LeoInlineError.swift` |
| 加载流光 | `LeoShimmer`（`PaperclipShimmer` 为别名） | `src/ios/Views/Components/LeoShimmer.swift` |
| 动效 | `LeoMotion`（无 reduceMotion 环境时用无参版本，读系统开关） | `src/ios/Shared/LeoDesignSystem.swift` |

动效审计：`grep -rn "withAnimation(.easeInOut(duration" src/ios/Views` 必须为 0。
