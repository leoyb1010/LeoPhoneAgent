delete: 54 张未被运行时或构建引用的原始 PNG 与 public 中的优化 WebP 重复，占 102 MB；只保留实际交付资产。 [src/mac/leocodebox/design/source-images]
delete: auto-changelog、cross-env、release-it、@release-it/conventional-changelog 没有脚本或配置入口；沿用现有明确发布脚本。 [src/mac/leocodebox/package.json]
delete: iOS 同时维护两套更新记录、两份版本已读状态和两个首启弹窗；删除 474 行旧实现，设置、关于与首次启动统一复用 LeoReleaseCatalog。 [src/ios/Views/Settings/LeoReleaseNotesView.swift]
delete: AppIcon 目录中的 6 张 1024px PNG 没有出现在 Contents.json，Xcode 明确报告 unassigned children；删除约 4.8 MB 未参与构建的图标草稿，只保留实际浅色/深色图标。 [src/ios/Assets.xcassets/AppIcon.appiconset]
shrink: 首页 Hero 重复展示主任务、舰队、快捷任务三条路线；收敛为一个主 CTA、一个跨 Mac CTA 和四项真实状态。 [src/mac/leocodebox/src/components/dashboard/cards/DashboardHero.tsx]
shrink: Agent 面板用七个嵌套迷你卡重复边框、背景和版本层级；改为紧凑状态行，保留登录、版本、升级和安装能力。 [src/mac/leocodebox/src/components/dashboard/cards/AgentGridCard.tsx]
guard: Mac 自动扫描全部 401 个可见按钮，禁止无处理函数或空处理函数；iOS 自动扫描 SwiftUI Button 与 tap gesture，只允许系统 Alert 的关闭按钮使用空 action。
net: 依赖 -4 个，锁文件净减 1,756 行，删除 60 张未使用 PNG、约 107 MB 和一整套重复更新实现；未删除任何产品能力。
