# Mac 1.85.0 发布记录

2026-09-12，已正式发布，非草稿、非预发布。

- [公开热更新及下载](https://github.com/leoyb1010/leocodebox-updates/releases/tag/v1.85.0)
- [主仓库 Release](https://github.com/leoyb1010/LeoPhoneAgent/releases/tag/v1.85.0)
- 源码提交：`35558b2484efd4c36b7c8d39b6c5ed0a5018c8fb`，已推送 main。

## 验证结果

桌面测试 45/45，前端 194/194，服务端 446/446；TypeScript、ESLint、更新记录 3/3 和生产构建通过。完整 npm audit 为 0。真实页面核对更新弹窗、项目抽屉 Escape、草稿保留、设置与独立收藏，无页面运行错误。

36 个嵌套 Mach-O 完成 Developer ID 签名与验证。第一轮 Apple 公证 `aebaefa9-47b7-4bc0-9929-72337002eca7` Accepted；包含钉章 App 的最终 DMG 公证 `8504f617-71fc-447c-b245-aaf325de2c05` Accepted。App 与 DMG 均通过 stapler validate；ZIP 解包副本加下载 quarantine 标记后仍通过 Gatekeeper（Notarized Developer ID）。

包内真实服务在隔离数据目录启动，health 回读 1.85.0。真实 Electron MacUpdater 从 1.84.0 通过公开生产 GitHub feed 发现 1.85.0 与 arm64 ZIP，无 Token；检查未执行自动安装，也未替换用户当前 /Applications 下的 App。测试为更新器自己的网络 session 使用本机现有代理，以避开当前直连 TLS 重置。

GitHub 两个 Release 的附件均已 uploaded，size / SHA-256 与本地签名、公证产物逐一一致。latest-mac.yml 的版本、ZIP size 和 SHA-512 也已核对。

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| leocodebox-1.85.0-mac-arm64.dmg | 250856934 | `5a63f511aea1954cee752c517e9727a35ff83046f1f6decb0e44dca7c598935c` |
| leocodebox-1.85.0-mac-arm64.zip | 253793793 | `84b42d612d217c1c48f50545543c8d06d1a702065e7de435a8cf76efbd332310` |
| latest-mac.yml | 360 | `8777594b39a4690f46a29c9272d651f622894088749f1d69c6d13eb8cb9ec9a5` |

## 构建与范围

构建在当前项目的临时验证副本完成，避免 iCloud 扩展属性破坏签名。提交钩子的 ESLint 卡在 iCloud 依赖文件读取后，先终止并等待原钩子恢复暂存状态，再使用临时钩子逐字节比对暂存 Mac 源码与构建副本，并在本地依赖环境重跑完整 lint 和更新记录门禁。未修改仓库的钩子配置。

日志与截图在 `outputs/implementation-2026-09-12/mac-release-1.85.0/`。本版交付队列、日志、工作台交互及依赖/IPC 修复；完整升级计划仍在进行。精确窗口组件不可用时返回明确降级，未宣称原生窗口动作全量验收。新增 iOS 日志状态源码已通过测试与设备目标构建，但未再次覆盖安装；之前 iPhone 1.35.0 (110) 的安装证据不包含这项后续更改。
