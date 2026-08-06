# LeoPhoneAgent 1.1.1–1.1.2 本地化升级记录

日期：2026-07-26  
最终版本：`1.1.2 (25)`  
目标设备：iPhone 17 Pro Max  
应用语言实测：`zh-Hans`

## 1.1.1（Build 24）：语言目录补齐

- 使用 Xcode Localization Export 从真实 Swift 源码重新提取 String Catalog。
- 补齐德语、法语、日语、韩语、俄语、简体中文和繁体中文缺失项。
- 新增 `scripts/SyncMissingLocalizations.py`：默认执行只读完整性检查；`--apply` 仅补缺失项并保留已有翻译。
- 审计结果：七种非英语语言缺失项为 0、格式占位符错误为 0、Token 术语保留错误为 0。
- 中文人工校准 Composer、Artifact、Quick Task 等上下文词，统一使用“输入区”“任务产出”“快捷任务”。

## 1.1.1 真机发现的问题

1. Token 数值仍显示 `K/k/M`。原因是聊天摘要、Token 用量页和用量统计页各自使用硬编码 Swift 格式器，不属于可翻译字符串。
2. 对话输入区上方的内置快捷按钮仍显示英文。原因是按钮读取 `QuickTaskDefinition.name` 的持久化动态字符串，绕过 String Catalog。
3. 真机偏好已读取确认 `appLanguage = zh-Hans`，问题与用户设置无关。

因此 1.1.1 不能作为本轮最终交付，按补丁版本规则继续升至 1.1.2（Build 25）。

## 1.1.2（Build 25）：修复真实渲染链路

- 新增 `LeoTokenCountFormatter`，直接使用当前 SwiftUI Locale 的系统 `compactName` 数字格式。
- 简体中文验证：`1,200 → 1200`、`12,345 → 1.2万`、`1,000,000 → 100万`；不再固定显示 K/k。
- Token 用量摘要的 Context、Input、Output、Cache Read、Cache Write 和输出速度均使用本地化文案；产品术语保持 `Token`。
- 内置快捷任务新增 `displayName`：仅当持久化名称仍等于内置默认英文名时才进行本地化；用户编辑过的名称和自定义任务名保持原样。
- 首页快捷入口、聊天输入区快捷按钮和快捷任务设置页统一改用 `displayName`。
- 新增回归测试：中文 Token 紧凑格式不得包含 K；自定义快捷任务名不得被自动翻译。

## 最终验证证据

- Release Archive：`/tmp/LeoPhoneAgent-1.1.2-final.xcarchive`
- 主 App、Agent Widget、File Provider、Share Extension：全部为 `1.1.2 (25)`。
- Team：`48H5Y3LNUK`；Bundle ID：`com.leoyuan.leophoneagent`。
- 主 App 深度严格签名与三个扩展独立签名校验通过。
- 从最终 App 的 `zh-Hans.lproj` 直接读取：
  - `Analyze Sleep → 分析睡眠`
  - `Health Report → 健康报告`
  - `Check Weather → 查看天气`
  - `Token Usage → Token 用量`
  - `Output Tokens → 输出 Token`
  - `%.1f Token/s → %.1f Token/秒`
- `MinisLogicTests` 的 simulator Build for Testing 成功，新增回归测试已编译、链接进入 Tests Bundle。
- 最终包已覆盖安装并启动；设备回读 LeoPhoneAgent `1.1.2 (25)`，主 App 与 Widget Extension 均在运行。
- 1.1.1 安装后的真实数据库审计为 Schema Contract `3 → 3`，3 个会话与 16 条消息保持不变；1.1.2 只改变显示层和本地化，不修改数据库结构。

## 后续本地化发布门

每次补丁发布必须同时通过：

1. Xcode String Catalog 原生编译。
2. 七种非英语语言缺失项为 0。
3. 格式占位符错误为 0。
4. Token 术语保留错误为 0。
5. 动态用户数据路径检查：内置可本地化，用户自定义值保持原样。
6. Locale 数字格式检查：不得在中文界面重新硬编码 K/k/M。
7. 最终 Archive 内语言资源实读，不只检查源码目录。
