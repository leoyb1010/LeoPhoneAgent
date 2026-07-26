# LeoPhoneAgent iOS 系统能力与后台执行审计

日期：2026-07-26  
范围：iPhone 优先，个人自用，当前发布线 1.0.x  
结论：底层系统能力已经很广，下一阶段的重点不是继续堆权限，而是把已有能力做成可发现、可观察、可中断、可恢复的任务体验。

## 一、本轮落地结果

### 主屏幕任务组件

- 新增普通 WidgetKit 主屏幕组件，支持小号与中号尺寸。
- 展示空闲、执行中、已暂停、已完成和需要处理五种语义状态。
- 状态由 App Group `group.com.leoyuan.leophoneagent` 共享，并在任务、工具或阶段变化时请求 WidgetKit 刷新。
- 隐私模式开启时，不向组件存储任务标题、工具状态或循环详情。
- 组件是“扫一眼”的低频状态面，锁屏和灵动岛上的近实时进度继续由 Live Activity 承担。

### 桌面语音入口

- 中号组件新增“Voice”按钮，通过 `leophoneagent://voice` 打开 App。
- 进入 App 后创建新对话，自动启动现有语音输入流程。
- Widget Extension 本身不持续开启麦克风。这样权限申请、录音指示、取消和转写状态都在前台 App 中清晰可见。
- 已有 Siri / App Intents 支持“Ask LeoPhoneAgent”、发送提示词、快速任务、会话状态、列出会话、追问和打开会话。

### iOS 26 锁屏后持续处理

- 新增 `BGContinuedProcessingTaskRequest`，用于前台由用户明确启动的长任务。
- 注册后台标识通配符 `com.leoyuan.leophoneagent.agent.*`，并加入 `processing` 后台模式。
- 系统进度不用虚假计时器。它根据真实 Agent 循环轮次和工具切换递增，任务完成时才达到 100%。
- 系统撤销执行时间时，进入现有的“暂停 + 停止当前命令 + 可恢复”链路，而不是假设进程永远存活。
- iOS 26 以下仍使用 `beginBackgroundTask` 的有限时间和现有中断恢复方案。

### 跨进程任务恢复

- 1.0.9 新增仅本机的持久化 Run State，与 Activity 事件日志分表保存，不进入 iCloud 同步。
- App 被 iOS 终止时，下一次启动会把遗留非终态转为“等待用户继续”，并同步到会话暂停徽章和聊天恢复入口。
- 这补上了流式文本中途被终止时消息尾部形态无法识别的盲区；恢复仍由用户明确触发，不会绕过 iOS 在后台自行重启任务。

## 二、为什么不能承诺“锁屏后永不中断”

iOS 没有向普通 App 提供任意计算的无限后台执行权。即使是 iOS 26 的 Continued Processing，系统仍可以因资源压力、用户取消、进度停滞或系统条件改变而终止任务。

因此 LeoPhoneAgent 的正确目标是：

1. 优先使用系统允许的最强执行通道。
2. 持续报告真实进度，并立即响应取消。
3. 在每个可恢复边界持久化会话、队列、工具状态和输出。
4. 被系统中断后显示明确状态，回到前台可继续，不静默丢任务。

不建议把无声音频或持续定位当成通用任务的无限后台保证。这两种后台模式应当只在 App 真正提供音频或定位服务时使用。

## 三、Apple 系统能力接入矩阵

| 能力 | 当前状态 | 代码或配置证据 | 下一步 |
|---|---|---|---|
| Live Activities / 灵动岛 / 锁屏 | 已接入 | `AgentLiveActivityManager.swift`、`AgentLiveActivityWidget.swift` | 真机压力测试，可选接 APNs 远程更新 |
| 主屏幕 Widget | 本轮已接入 | `AgentStatusWidget`、App Group 快照 | 真机添加小/中号组件验收 |
| 组件语音入口 | 本轮已接入 | `leophoneagent://voice`、`QuickActionWorkflow.startVoice` | 增加锁屏 Siri 口令回归测试 |
| Siri / App Intents / Shortcuts | 已接入 | `Agent/Intents/` | 增加个人自动化模板 |
| Home Screen Quick Actions | 已接入 | 新对话、语音、相机 | 保持 |
| iOS 26 Continued Processing | 本轮已接入 | `AgentContinuedProcessingManager` | 锁屏 15/30/60 分钟真机测试 |
| 有限后台任务 | 已接入 | `beginBackgroundTask` + 中断恢复 | 作为降级通道保留 |
| 后台上传/下载 | 部分 | 常规 URLSession 与 Provider 网络链路 | 大文件转为 background URLSession |
| 本地通知 | 已接入 | `NotificationOffload.m`、后台完成通知 | 增加恢复动作按钮 |
| iCloud / CloudKit | 已接入 | CloudKit entitlement、`CloudSyncEngine.swift` | 持续做冲突与离线测试 |
| File Provider | 已接入 | `MinisFileProvider` Target | 后续迁移内部兼容命名 |
| Share Extension | 已接入 | `MinisShare` Target | 后续迁移内部兼容命名 |
| HealthKit | 已接入 | entitlement + `HealthKitOffload.m` | 按需授权与写操作确认 |
| HomeKit | 已接入 | entitlement + `HomeKitOffload.m` | 高风险设备操作二次确认 |
| WeatherKit | 已接入 | entitlement + `WeatherOffload.m` | 保持 |
| Calendar / Reminders | 已接入 | EventKit 原生 Offload | 写入前显示变更摘要 |
| Photos / Camera | 已接入 | `PhotosOffload.m`、聊天相机 | 删除和批量改动增加确认 |
| Speech / Microphone / TTS | 已接入 | Speech framework、语音纠错、系统/第三方 TTS | 补齐锁屏语音回归测试 |
| Bluetooth / NFC | 已接入 | entitlement / usage description + Offload | 保持用户明确触发 |
| Location / Maps | 已接入 | CoreLocation / MapKit Offload | 不再把定位宣传为通用保活保证 |
| Music / Audio | 已接入 | MediaPlayer / AVFoundation / TTS | 区分真实播放与后台任务执行 |
| Face ID | 已接入 | `NSFaceIDUsageDescription`、会话锁 | 补充生物识别失败回归测试 |
| AlarmKit | 已接入 | `AlarmOffload.m`、闹钟列表 | 保持系统版本降级 |
| Spotlight / App Entities | 未系统化 | 已有 App Entity，未形成全局索引 | 索引会话标题和已保存快捷任务，不索引聊天正文 |
| Focus Filters | 未接入 | 无独立 Focus Filter | 低优先级，可用于工作/私人模型切换 |
| Control Center Controls | 未接入 | 无 Control Widget | 中优先级，可增加“开始语音”控件 |
| Action Button | 间接支持 | 可绑定已有 App Shortcut | 提供一键导入说明 |
| watchOS | 未接入 | 无 Watch Target | 暂不做，iPhone 体验稳定后再评估 |
| CarPlay | 未接入 | 无 CarPlay entitlement / 场景 | 不建议当前投入 |

## 四、重点缺口与优先级

### P0：真机后台耐久性

- 在开发者模式真机上验证锁屏 15、30、60 分钟。
- 覆盖模型流、iSH 命令、FFmpeg、浏览器导航、网络切换、低电量和用户主动取消。
- 验收不只看“进程没死”，还要检查任务状态、进度、取消、通知和回前台恢复。

### P0：可恢复检查点

- 模型流式回复应持续保存已确认的内容边界。
- 长命令和媒体处理应保存参数摘要、输出临时路径和可重试状态，不保存敏感原文。
- 浏览器任务被 iOS 中断后，应从安全的 Agent 步骤重试，不盲目重放已可能提交的表单。

### P1：大文件 background URLSession

上传、下载和云备份不应占用 Continued Processing 的通用计算时间。对于可文件化的网络传输，优先切到 background URLSession，让系统在 App 被挂起后继续传输。

### P1：控制中心语音入口

主屏 Widget 已解决普通入口。后续可增加 Control Center Control，并复用同一个 `leophoneagent://voice` / App Intent 路由。

### P2：Spotlight 与 Focus Filter

两者都是体验增强，不是当前稳定性瓶颈。应在后台任务和可恢复链路通过真机耐久测试后再做。

## 五、系统策略选择表

| 任务类型 | 应使用的 iOS 机制 |
|---|---|
| 用户在前台启动的长 Agent 任务 | iOS 26 Continued Processing + Live Activity + 持久化恢复 |
| 数十秒内的短收尾 | `beginBackgroundTask` |
| 系统择机执行的维护/索引 | `BGProcessingTask` |
| 大文件上传、下载 | background URLSession |
| 近实时锁屏进度 | ActivityKit Live Activity |
| 主屏幕概览 | WidgetKit Timeline + App Group 快照 |
| 语音启动 | Widget / Control / Action Button 打开 App，或 Siri App Intent |
| 可预见的定时自动化 | Apple Shortcuts Automation |

## 六、官方技术依据

- [Displaying live data with Live Activities](https://developer.apple.com/documentation/ActivityKit/displaying-live-data-with-live-activities)
- [Starting and updating Live Activities with push notifications](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)
- [Choosing Background Strategies for Your App](https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app)
- [Performing long-running tasks on iOS and iPadOS](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados)
- [BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)
- [Finish tasks in the background, WWDC25](https://developer.apple.com/videos/play/wwdc2025/227/)
- [Adding interactivity to widgets and Live Activities](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities)
- [Creating your first app intent](https://developer.apple.com/documentation/appintents/creating-your-first-app-intent)
- [Speech framework](https://developer.apple.com/documentation/speech/)
