# LeoPhoneAgent 单仓合并与交付就绪说明

日期：2026-08-11

## 结论

LeoPhoneAgent iOS、Mac 桌面工作台与 Mac 常驻服务已统一进入
`leoyb1010/LeoPhoneAgent`。Mac 源码位于 `src/mac/leocodebox/`，保留原始
提交历史与内部兼容标识；以后产品源码、Issue、CI 和版本说明只在主仓维护。

## 合并基线

- 原 Mac 源码仓：`leoyb1010/leocodebox`
- 核验提交：`50199a1d21edcd914245e17fa4c76ee9a7ba6b0c`
- 核验结果：该提交同时是本地 `main` 与抓取后的 `origin/main` 顶端。
- 合并方式：Git subtree，目标目录 `src/mac/leocodebox/`，保留可追溯历史。
- 主仓合并提交：`e683b2c0`。

## 仓库职责

| 仓库 | 交付后的职责 |
| --- | --- |
| `LeoPhoneAgent` | 唯一源码仓：iOS、Watch、Widget、Mac 桌面端、Mac 服务、CI、文档与 Issue |
| `leocodebox` | 历史只读入口；源码迁移完成后归档 |
| `leocodebox-updates` | 仅承载 Mac 自动更新签名产物与 release metadata |

将源码仓与更新产物仓分开，既避免多源码事实源，又不会破坏既有 Electron
自动更新链路。

## 产品与工程调整

- iOS 首页改为“输入即开始”，历史分组默认折叠，能力入口统一对齐。
- iOS 设置改为可搜索的控制中心式折叠布局；藏宝阁补齐捕获入口和信息层级。
- iOS 全局动效使用现有 SwiftUI 设计语言实现，遵守“减少动态效果”设置。
- Mac 首页和设置收敛重复卡片与装饰，品牌统一为 LeoPhoneAgent · Mac。
- 删除 54 张未被运行时和构建引用的设计源图，减少约 102 MB 工作树体积；
  文件仍可从 Git 历史恢复。
- CI 同时覆盖 iOS 单元测试与 Mac typecheck、lint、test、build。

## 发布门禁

本次版本为 iOS `1.23.1 (93)`、Mac `1.67.1`。交付必须满足：

1. iOS 发布审计、辅助功能/动效审计、无签名构建通过。
2. Mac TypeScript、ESLint、全部测试和 production build 通过。
3. iPhone 与 iPad 安装同一签名构建并完成首页、设置、藏宝阁视觉复核。
4. Mac 安装新构建并完成首页、设置视觉复核。
5. 主仓推送成功后，原源码仓才可切换为只读归档。

## 最终验证结果（2026-08-12）

- iOS 三项门禁通过；229 项逻辑测试通过，0 失败、0 跳过。
- iOS 可见控件审计覆盖 831 个 SwiftUI `Button` 声明和 31 个点击手势；未发现空操作控件，43 个空 action 均为系统 Alert 的关闭按钮。
- 同一份 Apple Development 签名的 iOS `1.23.1 (93)` 已通过 Wi-Fi 安装到 iPhone 17 Pro Max 和 iPad Pro 13 英寸；两台设备均完成启动，首页完成真机截图复核。
- Mac TypeScript、ESLint、456 项测试和 production build 通过；401 个可见按钮通过 AST 交互契约扫描，production 依赖漏洞为 0。
- Developer ID 签名的 Mac `1.67.1` 已安装到 `/Applications/leocodebox.app`，本地服务健康检查通过，首页设置、刷新、舰队、开始任务、能力健康、任务板和项目工作区均完成真实点击复验。
- 本地 DMG 校验和与嵌套签名有效；当前机器没有可用的 Apple 公证凭据，因此该 DMG 仅作为本机交付包，不会发布到公开更新仓。

完整的控件与安装后复验记录见 `docs/INTERACTION_QA_2026-08-12.md`。

## 已知技术债边界

iOS 仍包含上游和既有代码中的 Swift 6 隔离、旧 API 与 Objective-C
nullability 警告。本次变更不把“能构建”误报为“零警告”；这些警告不阻断
当前 Swift 5 构建，但应按模块逐步清理，避免和 UI 重构混成一次高风险改写。
本次新增界面不引入新的致命构建错误。
