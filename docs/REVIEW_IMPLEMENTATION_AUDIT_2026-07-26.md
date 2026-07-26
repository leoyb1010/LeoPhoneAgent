# LeoPhoneAgent 评审实施审计

日期：2026-07-26  
依据：`LeoPhoneAgent_升级计划评审与补充_2026-07-26.md`  
当前版本：1.0.12（Build 13）  
范围：仅 iOS

## 结论

评审提出的 P0.5 快速修复包、1.1 的任务可观察性与取消主链路、1.2 的能力中心和 Provider 保存前真实测试已经落地。1.3 已完成持久化 Run State、`isProcessing.didSet` 副作用分层与 QuickTask AppEntity 化；1.4 的产物中心和同步升级作为下一独立阶段继续后置。

## 逐项状态

| 评审项 | 状态 | 当前证据 |
|---|---|---|
| P1 Live Activity 锁屏隐私默认开启 | 完成 | `BackgroundKeepAliveManager` 与 `AgentLiveActivityManager` 使用默认隐私快照 |
| P2 排队输入不得写入可分享日志 | 完成 | 队列、Share Sheet、聊天注入日志仅保留长度和数量 |
| P3 shell 输出日志风险 | 完成基础防护 | `LoggingManager` 经 `EnvVarRedactor` 处理；设置与同意页明确日志可能包含 shell 输出 |
| P4 Keychain / iCloud 数据说明 | 完成 | Provider 同意页与配置页说明 Keychain、本机直连和私人 iCloud 同步边界 |
| P5 OAuth 与 Provider 日志正文 | 完成当前高风险路径 | URL、Token 片段、请求/响应正文、SSE 预览改为 host、path、状态码、字节数和字段数 |
| B1 NFC / Bluetooth 权限闸门 | 完成 | 两项均进入 `OffloadPermissionManager.allCommands` |
| B2 shell 包装绕过 | 已披露，根治后置 | 能力详情明确闸门仅覆盖直接调用；系统授权仍是最终边界 |
| B3 NFC NDEF entitlement | 完成 | Entitlement 已包含 NDEF reader session format |
| B4 Photos / Location 权限口径 | 完成 | 能力中心明确照片删除需显式请求，Location 仅描述按需当前位置 |
| B5 Health Records 过度声明 | 完成 | 删除未使用的 clinical health records entitlement |
| 浏览器、并发工具、Native Offload、FFmpeg 取消 | 完成 | 1.0.2–1.0.5 分层落地真实取消与配对取消结果 |
| 停止当前 / 停止全部并清队列 | 完成 | UI 和队列策略已拆分，避免停止后意外继续 |
| Activity Log / Timeline | 完成第一版 | 设备本地 SQLite 日志、聊天状态卡和设置内历史视图 |
| 派生 `AgentActivityPhase` 与统一工具映射 | 完成第一版 | 状态模型、工具图标/文案映射由聊天、Widget、Live Activity 共用 |
| Apple Capabilities Center | 完成第一版 | 只读授权探针、能力动作、示例、数据去向、Agent Access 和已知边界 |
| Provider 保存前真实请求测试 | 完成 | API Key、OAuth、手动 Token 均先做匹配能力测试；失败可明确选择仍然保存 |
| Widget / 语音入口 | 完成第一版 | 小号/中号任务 Widget、任务深链与前台语音输入入口 |
| iOS 26 Continued Processing | 完成第一版 | 长任务进度、系统撤销处理、暂停与恢复；不承诺无限后台运行 |
| ContentView 组件纯移动拆分 | 首批完成 | 外观设置支持组件与首页状态提示组件已拆为独立文件；UI、交互、文案和动效保持不变 |
| 持久化 Run State | 第一阶段完成 | 独立 `agent_run_state`、旧事件回填、意外终止恢复、徽章与会话继续入口已接入；保持 device-local |
| `isProcessing.didSet` 显式状态机化 | 第三阶段完成 | didSet 仅做转移分发；开始/停止副作用已归入专用处理器并保持原顺序，后续可逐项改为相位订阅 |
| QuickTask AppEnum → AppEntity | 完成兼容迁移 | 新入口使用可编辑 AppEntity 任务库；旧 Intent、AppEnum 类型和八个 raw ID 保留用于历史快捷指令 |
| 产物中心、跨设备同步升级 | 待 1.4 | 需同时覆盖本地、CloudKit V1/V2 和冲突策略 |

## 1.0.7 验收口径

- 能力中心打开和刷新不得触发权限弹窗。
- 状态来源必须是系统只读查询；系统不提供静态查询时显示“使用时检查”，不伪造已授权。
- Provider 测试成功前不写入 ProviderConfigStore；临时候选凭据测试失败后清理。
- 非标准代理测试失败时保留“仍然保存”，避免破坏兼容性。
- 自动日志不得记录提示词、回复、工具参数、Token 片段、通知标题或完整浏览 URL。
- 正式验收以 arm64 签名真机构建、覆盖安装、启动和 App/Widget 进程检查为准。

本轮结果：1.0.7 Build 8 已使用团队 `48H5Y3LNUK` 签名，覆盖安装到配对的 iPhone 17 Pro Max；设备回读版本为 1.0.7（8），主 App 与本次安装路径下的 Widget Extension 均在运行。

## 1.0.8 验收口径

- 只做组件纯移动，不改变首页与外观设置的信息架构、视觉、交互和动效。
- `ContentView.swift` 不再声明外观选项、语言选项、字号滑杆、同步旋转图标和同步提示条。
- 新文件必须仅加入主 App target，Xcode 工程结构和 plist 均可解析。
- 通用 iOS 主 App 构建与独立逻辑测试 Bundle 编译必须成功；正式发布仍以签名真机覆盖安装、启动和版本回读为准。

本轮结果：1.0.8 Build 9 已使用团队 `48H5Y3LNUK` 签名，覆盖安装到配对的 iPhone 17 Pro Max；设备回读版本为 1.0.8（9），主 App 与本次安装路径下的 Widget Extension 均在运行。

## 1.0.9 验收口径

- Run State 只保存稳定 ID、时间、阶段、工具名和枚举原因，不保存提示词、回复、工具参数或输出。
- 数据保存在独立设备本地数据库，不进入 ChatStore 或 CloudKit 同步 schema。
- 上一进程遗留的非终态必须转为 `waitingForUser + unexpectedTermination`；终态不能被重新打开。
- 新 Run 必须终结同会话遗留的非终态，避免恢复徽章反复出现。
- 会话详情和启动徽章对账都必须消费持久状态，同时保留旧消息尾部兼容判断。
- 模拟器测试用例执行器仍卡在启动阶段，因此只记录测试 Bundle 编译链接成功；不得宣称用例实际执行通过。

本轮结果：1.0.9 Build 10 已使用团队 `48H5Y3LNUK` 签名，覆盖安装到配对的 iPhone 17 Pro Max；设备回读版本为 1.0.9（10），主 App 与本次安装路径下的 Widget Extension 均在运行。SQLite 回填、意外终止恢复和旧 Run 取代语句已通过独立内存数据库验证。

## 1.0.10 验收口径

- `false→true` 只能产生 `.started`，`true→false` 只能产生 `.stopped`，重复赋值必须是 `.unchanged`。
- `isProcessing.didSet` 继续是旧消费者的兼容入口，不在本轮替换 20 余个任务调用点。
- 开始与结束分支内的副作用顺序、前台守卫和历史缺陷保护不得改变。
- 主 App 与独立逻辑测试 Bundle 必须成功编译；模拟器执行器已知挂起不写成测试通过。

本轮结果：1.0.10 Build 11 已使用团队 `48H5Y3LNUK` 签名，覆盖安装到配对的 iPhone 17 Pro Max；设备回读版本为 1.0.10（11），主 App 与本次安装路径下的 Widget Extension 均在运行。

## 1.0.11 验收口径

- `isProcessing.didSet` 只更新析构诊断快照并分发显式 started/stopped/unchanged。
- started 处理顺序必须保持：暂停云同步 → 清理旧 hold → 启动卡顿监控。
- stopped 处理顺序必须保持：建立 post-stop hold → 释放卡顿监控 → 安全快照/延期标记 → 离屏通知 → 技能刷新。
- 后台、UI 挂起和会话转场时不得同步应用大型 diffable snapshot。
- 本轮只做行为等价分层，不改变调用点、可恢复判断、UI 或任务执行策略。

本轮结果：1.0.11 Build 12 已使用团队 `48H5Y3LNUK` 签名，覆盖安装到配对的 iPhone 17 Pro Max；设备回读版本为 1.0.11（12），主 App 与本次安装路径下的 Widget Extension 均在运行。

## 1.0.12 验收口径

- 新建快捷指令必须使用 `QuickTaskEntity`，任务列表由设备本地可编辑存储提供。
- 旧 `QuickTaskIntent` 的类型名、AppEnum 参数类型、八个 case 与 raw ID 不得删除或改名。
- 内置任务缺失或存储损坏时必须自动补回；重复 ID、空名称和空提示词不得进入有效目录。
- 内置任务不可删除，自定义任务删除前必须提示已有快捷指令需要重新选择。
- 名称、提示词、图标和顺序更新后必须触发 App Shortcuts 参数刷新。
- 测试 Bundle 只记录编译链接成功；已知模拟器执行器未实际跑通，不宣称测试用例执行通过。

本轮结果：通用 iOS arm64 主 App 构建成功，App Intents 元数据成功生成，独立 `MinisTests.xctest` 编译链接成功。1.0.12 Build 13 已使用团队 `48H5Y3LNUK` 完成签名构建，覆盖安装到在线 iPhone 17 Pro Max 并成功启动；设备回读版本为 1.0.12（13），主 App 与本次安装路径下的 Widget Extension 均在运行。

设备清理：原版 OpenMinis（`com.openminis.app`）已从验收设备卸载；复核安装列表与运行进程后，仅保留 LeoPhoneAgent 自有包、主进程和本版本 Widget Extension。

## 下一阶段重点

1. 1.0.12 作为本轮稳定性、系统接入和快捷指令基础阶段的收官版。
2. 下一阶段先为 ChatStore 建立可执行的数据层测试基线。
3. 再进入产物中心、本地文件生命周期和 CloudKit V2 同步设计，避免无测试迁移。
4. UI 深度升级继续采用真机截图审计，不与高风险数据迁移混在同一补丁版本。
