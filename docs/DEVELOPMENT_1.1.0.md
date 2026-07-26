# LeoPhoneAgent 1.1.0 开发检查点

正式版本：`1.1.0`  
稳定基线：`leophoneagent-1.0.12` / `eeb3ea1`  
开发策略：中间只递增 Build，不覆盖安装正式版；每个高风险层独立提交，可定位、可测试、可回滚。

## 检查点规划

| Build | 范围 | 状态 | 回滚边界 |
|---|---|---|---|
| 14 | ChatStore Schema Contract、迁移与恢复测试门禁 | 已完成 | 不新增用户数据类型，可直接回到 1.0.12 |
| 15 | Artifact 本地模型与文件生命周期 | 已完成 | 尚未接入 UI/CloudKit，独立提交可整体回滚 |
| 16 | Artifact Tray、Quick Look、分享 | 已完成 | UI 只调用 Build 15 Repository，可独立移除 |
| 17 | Artifact 版本与聊天/任务/Files 统一引用 | 已完成 | 保留原始文件引用 |
| 18 | CloudKit V2 / CKAsset | 已完成 | Artifact 分类默认关闭，本地数据不依赖云端 |
| 19 | 个人任务模板与结构化输出 | 已完成 | 基于 1.0.12 QuickTask AppEntity 向前兼容扩展 |
| 20 | Composer、首页与运行策略定制 | 已完成 | 独立偏好键 + 既有状态机，默认行为可回退 |
| 21 | 动效、触感、Reduce Motion、无障碍 | 已完成 | 纯表现层 + 自动审计门 |
| 22–23 | 全流程回归、迁移演练、真机审计、1.1.0 发布 | 待开始 | 发布候选标签 |

## Build 14 证据

- `ChatStoreSchemaContract` 由生产 `ChatStore.createTables()` 调用，不是测试专用副本。
- Schema 变更使用 `BEGIN IMMEDIATE` / `COMMIT`，失败执行 `ROLLBACK`。
- 覆盖新库、旧库升级、数据与派生字段保留、幂等重跑、缺表缺列检测。
- macOS SQLite runner：`ChatStoreSchemaSmoke: 4/4 passed`。
- `MinisTests.xctest`：编译及链接成功。
- 通用 iOS arm64 主 App：`BUILD SUCCEEDED`。
- Xcode iOS Simulator runner：启动 worker 阶段停滞并人工中断，不计为测试执行通过。

复现 smoke runner：

```sh
xcrun swiftc \
  src/ios/Agent/Chat/ChatStoreSchemaContract.swift \
  scripts/ChatStoreSchemaSmoke.swift \
  -o /tmp/LeoPhoneAgentChatStoreSchemaSmoke \
  -lsqlite3
/tmp/LeoPhoneAgentChatStoreSchemaSmoke
```

## Build 15 证据

- Schema Contract 升级到 v2，事务式、幂等创建 `artifacts` 与 `artifact_versions`。
- Artifact 文件使用受控根目录、安全文件名与标准化路径校验，避免目录穿越。
- 新建和追加版本先进入 staging；数据库事务失败时回滚并清理未提交文件。
- 覆盖新建、追加版本、版本顺序、SHA-256、软删除、恢复、永久清理与危险文件名。
- `ArtifactRepositorySmoke: lifecycle passed`。
- `ChatStoreSchemaSmoke: 4/4 passed`。
- Swift 6 `MinisTests.xctest` 编译及链接成功；通用 iOS arm64 主 App `BUILD SUCCEEDED`。
- 本检查点只建立本地能力，不接入 Artifact Tray，不向 CloudKit 写入，也不安装到真机。

复现 Artifact runner：

```sh
xcrun swiftc -parse-as-library \
  scripts/ArtifactRepositorySmoke.swift \
  src/ios/Agent/Artifacts/ArtifactModels.swift \
  src/ios/Agent/Artifacts/ArtifactRepository.swift \
  src/ios/Agent/Chat/ChatStoreSchemaContract.swift \
  -o /tmp/LeoPhoneAgentArtifactRepositorySmoke
/tmp/LeoPhoneAgentArtifactRepositorySmoke
```

## Build 16 证据

- 聊天更多菜单新增会话级 Artifacts 入口，不改变主导航信息架构。
- Tray 使用系统 List、Quick Look 与 Share Sheet，覆盖加载、空、错误、列表和回收站状态。
- 支持预览、分享、下拉刷新、软删除、恢复与永久删除确认。
- 动态字体、VoiceOver 合并标签、系统深浅色与 Reduce Motion 已接入。
- taste-skill 审查结论：原生移动端以 Apple HIG 为主，不引入网页式玻璃卡片或装饰动画。
- `MinisTests.xctest` 编译及链接成功；通用 iOS arm64 主 App `BUILD SUCCEEDED`。
- 本检查点不创建 Artifact，不改变聊天消息结构，不写入 CloudKit，不安装到真机。

## Build 17 证据

- Schema Contract 升级至 v3，为 Artifact 增加可空的 `source_path`，使用会话和源路径唯一索引维护同一成果的版本链。
- 仅捕获 `/var/minis/workspace/` 中由成功工具调用生成或修改的普通文件；内部路径与超过 100 MB 的文件不自动收录。
- 同路径、同 SHA-256 不生成重复版本；内容变化时追加不可变版本，并保留原始 Files 路径与来源消息 ID。
- Tray 新增版本历史，任意版本均可 Quick Look 与分享；删除 Artifact 不删除原始 workspace 文件。
- `ChatStoreSchemaSmoke: 4/4 passed`；`ArtifactRepositorySmoke: lifecycle passed`。
- Swift 6 `MinisTests.xctest` 编译及链接成功；通用 iOS arm64 主 App `BUILD SUCCEEDED`。
- 本检查点仍不写入 CloudKit，不安装到真机。

## Build 18 证据

- 复用现有 `SyncCore` / `ICloudSharedZoneTransport`，新增 `ArtifactV2` 元数据记录与 `ArtifactVersionV2` CKAsset 记录，均进入 `minis-shared` 私有数据库固定 zone。
- Syncable Registry、Hydrator、CloudKit zone 路由、近期查询、dirty queue 白名单和设置分类已形成完整闭环。
- Artifact 分类首次读取默认为关闭；关闭时既不入 dirty queue，也不接收远端合并或 tombstone。
- 显式开启时会标记所有现有 Artifact 元数据及未超过用户上限的版本；默认 CKAsset 版本上限 25 MB。
- 入站 CKAsset 同时验证 `byteCount` 与 SHA-256，并原子落盘到 Artifact 受控目录；远端合并 API 不发出本地变更通知。
- 永久删除对 Artifact 和版本发送 tombstone，并使用近期删除表防止 CloudKit 查询窗口内的旧记录复活；软删除只同步 `trashedAt`。
- `ChatStoreSchemaSmoke: 4/4 passed`；`ArtifactRepositorySmoke: lifecycle passed`，后者包含远端资产完整性与受控副本验证。
- Swift 6 `MinisTests.xctest` 编译及链接成功；通用 iOS arm64 主 App `BUILD SUCCEEDED`。
- 本检查点未安装真机，未修改手机上的 1.0.12 Build 13，也未自动打开 Artifact 云同步。

## Build 19 证据

- 不新建一套重复的模板数据库，而是向前扩展 1.0.12 已经稳定的 `QuickTaskDefinition` / `QuickTaskEntity` / `QuickTaskStore`。
- 自定义 Codable 解码对旧 JSON 的缺失 `outputMode` 提供 `.automatic` 默认值，并保持八个内置标识与兼容 AppEnum 不变。
- 输入槽位由 Prompt 内 `{{name}}` 标记派生，支持去重、渲染和未传值的明确占位提示，不保存无意义的重复字段。
- 结果契约支持 automatic / conciseText / markdown / json / artifact，其中 artifact 要求 Agent 把最终结果保存到 workspace，由 Build 17 自动收录。
- `RunQuickTaskIntent` 新增可选的模板输入，不改变旧 `QuickTaskIntent` 参数模型；`SendPromptResult` 向后兼容新增输出模式和会话 Artifact 文件名。
- 设置页使用原生 Form、Picker、context menu 和系统分享，补齐自动识别输入、结果格式与 `.leotask.json` 导出；不改主导航。
- taste-skill 检查结论：原生移动端以 Apple HIG 为主；界面保持现有 List/Form 密度，不加模板化卡片、渐变或装饰动画。
- `QuickTaskTemplateSmoke: template lifecycle passed`，覆盖旧数据解码、槽位渲染、结构化输出契约与导出/导入身份隔离。
- Swift 6 `MinisTests.xctest` 编译及链接成功；通用 iOS arm64 主 App `BUILD SUCCEEDED`；未安装真机。

## Build 20 证据

- `QuickTaskStore` 独立保存最多三个 Composer Task ID；首次使用默认前三项，加载时过滤不存在项、去重并截断，删除自定义任务同步清理固定引用。
- Quick Tasks 设置页可查看、移除或选择 Composer 快捷动作；达到三项上限会明确提示，不静默替换用户已有选择。
- Composer 只新增 AnyView 擦除的横向原生按钮行，不改 `inputBottomRow`、语音双实现、附件状态或 380/320ms 输入高度校正；模板点击只准备 Prompt，不自动消耗模型。
- 空会话首页通过现有 `QuickActionWorkflow` 的 ensuringHome → pendingDispatch → chatReady 检查点打开草稿，并新增无 Cover 的 terminal-success 处理，避免模板被重试重复填入。
- `LeoSessionListDensity` 只控制列表垂直留白和 Provider 图标尺寸；文字继续使用现有 FontSettings 与系统辅助功能。
- `LeoRunPolicy.backgroundReady` 是发送前的增量准备：启用既有 Enhanced Background、Live Activity 与 Task Notifications，不请求新权限，也不承诺系统不挂起；长按发送可单次覆盖。
- taste-skill / Apple HIG 检查：继续使用 List、Picker、Menu、原生 bordered control 和系统语义；快捷动作是实际操作入口，不引入装饰性卡片、渐变或常驻动画。
- `QuickTaskTemplateSmoke: template lifecycle passed`；通用 iOS arm64 主 App `BUILD SUCCEEDED`。测试 Bundle 编译验证见本检查点提交前记录；未安装真机。
- Simulator 的 `test-without-building` 已尝试，但 Xcode 停在 `waiting for workers to materialize` 的 runner 启动层，未进入任何 Test Case；该次运行不计为测试通过，逻辑证据采用独立 smoke + `MinisTests.xctest` 编译，完整模拟器回归留到 Build 22 重新执行。

## Build 21 证据

- `LeoHaptics` 读取统一的 `leo.hapticsEnabled` 偏好且默认开启；全仓原生 UIKit Feedback Generator 只允许出现在该门面中，原先 ViewModel 两处裸调用已迁移。
- 外观设置提供触感开关；该开关只控制 LeoPhoneAgent 自己发起的动作反馈，不伪装成系统级总开关。
- 所有包含 `repeatForever` 的 Swift 文件都具备 `accessibilityReduceMotion` 或 `UIAccessibility.isReduceMotionEnabled` 分支；同步旋转、加载、Shimmer、工具跳点、思考、浏览器和语音在减少动态效果时保持可读的静态状态。
- Composer 保留 AnyView 和 0.28s 面板/380ms + 320ms 高度校正契约；只把文本/语音切换接入现值 LeoMotion token，没有调整耦合时长。
- VoiceOver 对关键任务相位做低频公告，不播报每次 Token 或工具文本变化；Composer 图标按钮和个人任务准备动作均有语义名称与 Hint。
- `scripts/IOSAccessibilityMotionAudit.sh` 成功：`centralized haptics and repeating-motion gates passed`。
- `QuickTaskTemplateSmoke: template lifecycle passed`；`MinisTests.xctest` 编译成功；通用 iOS arm64 主 App `BUILD SUCCEEDED`；未安装真机。

## 回滚规则

1. 1.0.12 稳定基线不得改写或移动标签。
2. Artifact 与 CloudKit 分属不同检查点，禁止合并成不可拆分提交。
3. 新数据能力先关闭写入与同步，再完成旧库 fixture、幂等迁移和降级读取验证。
4. 只有 Build 22–23 完成真机迁移演练后才将正式版本号改为 1.1.0。
