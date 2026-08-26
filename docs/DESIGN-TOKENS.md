# LeoPhoneAgent 设计 token（四端对照）

T2.5 唯一强调色：青绿。警告色、品牌色（如 xAI 橙）不改。

| 端 | 浅色强调 | 深色强调 | 出处 |
|---|---|---|---|
| Android | `#2E8B8B` | `#4DD9D9` | `src/android/.../ui/theme/Theme.kt` |
| iOS | 系统 Teal | 系统 Teal | SwiftUI `.teal` / `LeoTheme` |
| Mac | HSL `175 77% 26%` | HSL `158 84% 64%` | `src/mac/leocodebox/src/styles/tokens.css` |
| Harmony | `#2E8B8B` | `#4DD9D9` | `src/harmony/.../theme/Tokens.ets` |

设置四组（各端同一顺序、同一用词）：我的设备 / Agent / 外观与通用 / 数据与关于。
