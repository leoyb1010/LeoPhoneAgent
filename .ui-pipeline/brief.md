# UI Brief

## Outcome

- User-visible outcome: Android、iPad 和 Mac 都有低打扰的原生藏宝阁捕获入口；三端可搜索、筛选、阅读、查看处理状态、保存定位高亮与批注，并通过增量协议跨端使用元数据和按需正文/附件。
- Success signal: 分享不必打开聊天；原文件先保存；失败可见可重试；PDF 可逐页命中；Mac 离线保留陈旧缓存且同步范围可控；Fold 宽度变化不丢查询、选择、滚动和批注草稿。

## Users and situation

- Primary users: 随手收藏网页、截图、PDF、文件和聊天产物，并希望稍后交给 Agent 的个人用户。
- Job to be done: 先可靠收下，再离线搜索/阅读；需要时受控交给 Agent。
- Environment and devices: Android 手机与 Fold8 双宽度、iPhone/iPad 多窗口、Mac 工作台。
- Visitor mode: Operate

## Product truth

- Unique mechanism: 本机 SQLite/Room/Mac DB 保存原始内容，后台增强与 Agent 工具都围绕同一 TreasureItem 语义工作。
- Primary change: Android 从缺失变为完整本地藏宝阁；三端增加阅读状态、进度、高亮、精确筛选与 PDF 逐页文本；前 500 条镜像替换为游标增量同步，Mac 从镜像升级为可捕获、离线、按需取回并引用到 Agent 的工作台。
- Real proof: Compose/SwiftUI/React 实现、Room 11→12、双 flavor 编译/单测/lint、304 项 iOS 逻辑测试、Relay 12 项安全/协议测试、160 项 Mac client、392 项 Mac server、production build 与真实浏览器工作台验证。

## Scope

- In scope: Android 搜索/筛选/详情/批量/分享/文件/Agent，iPad 拖放，iOS Artifact，三端处理状态/阅读进度/定位高亮/PDF 逐页文本，游标增量同步、按需正文/附件、Mac 本机工作台和同步范围控制。
- Out of scope: 可选语义召回/RRF、内置音频转写、HTTP Range 断点续传和真实三设备发布矩阵。

## Constraints

- 原始保存不依赖网络、OCR 或模型。
- Android Standard 不得依赖 Power 权限或常驻服务。
- 200% 字体、TalkBack、折叠切换和进程恢复必须有明确设计；本机无 AVD 时保持视觉 HOLD。
- 三端继承各自原生组件，不共享 UI 框架。

## References

- Android: 现有 Material 3 导航、主题、列表和对话框。
- iOS/iPadOS: 现有 CollectionsView、Artifact Tray、AttachmentImporter。
- Mac: 现有 leocodebox Fleet/CollectionsMirror、API client、主题 token。

## Open verification

- Fold8 两尺寸、200% 字体、TalkBack、预测性返回和折叠过程的真实运行证据。
- iPhone/iPad 主 App 因本机缺少 watchOS 26.5 尚未完成模拟器运行。
- Mac 真实拖放和屏幕阅读器走查。
