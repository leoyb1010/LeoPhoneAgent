# 工程文档入口

当前开发入口与规则以根 README、根 AGENTS 及目标目录 AGENTS 为准；版本以工程与安装记录分别核对。

| 主题 | 权威入口 |
| --- | --- |
| 系统边界 | [ARCHITECTURE](ARCHITECTURE.md) |
| 数据流与隐私 | [PRIVACY](PRIVACY.md) |
| 当前实施顺序 | [ROADMAP](ROADMAP.md) |
| 本轮未关闭项 | [OPEN_ISSUES](OPEN_ISSUES.md) |
| Android 签名与发布 | [完整规则](ANDROID_RELEASE_RULES.md) |
| Mac 1.x | [Mac 主线](mac-3.0/README.md)、[项目规则](../src/mac/leophone/AGENTS.md) |
| 屏幕写操作授权 | [spec](../src/mac/leophone/docs/specs/leo-screen-write-approval.md) |
| Renderer/外部资源边界 | [spec](../src/mac/leophone/docs/specs/desktop-renderer-boundary.md) |
| iOS 安装 | [唯一入口](../scripts/InstallIOSRelease.sh)、[更新说明](../src/ios/Views/Settings/LeoReleaseNotesView.swift) |
| Harmony 原生构建/版本 | [构建入口](../src/harmony/scripts/build_hap.sh)、[更新说明](../src/harmony/app/entry/src/main/ets/release/ReleaseCatalog.ets) |
| 历史交付事实 | [Harmony 0.5.0](harmony-ux-20261108/DELIVERY.md) |
| 所有版本变化 | [CHANGELOG](../CHANGELOG.md) |

历史计划、候选报告和旧审计保留作证据，不能据此推断当前源码目录、已安装版本或构建结果。新证据应写到当前交付记录，而不是覆盖历史事实。
