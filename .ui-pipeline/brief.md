# UI Brief

## Outcome

- User-visible outcome: Android、iPad 和 Mac 都有低打扰的原生藏宝阁捕获入口；Android 可在手机/宽屏间连续搜索、筛选、阅读和批注。
- Success signal: 分享不必打开聊天；原文件先保存；失败可见可重试；Fold 宽度变化不丢查询、选择和批注草稿。

## Users and situation

- Primary users: 随手收藏网页、截图、PDF、文件和聊天产物，并希望稍后交给 Agent 的个人用户。
- Job to be done: 先可靠收下，再离线搜索/阅读；需要时受控交给 Agent。
- Environment and devices: Android 手机与 Fold8 双宽度、iPhone/iPad 多窗口、Mac 工作台。
- Visitor mode: Operate

## Product truth

- Unique mechanism: 本机 SQLite/Room/Mac DB 保存原始内容，后台增强与 Agent 工具都围绕同一 TreasureItem 语义工作。
- Primary change: Android 从缺失变为完整本地藏宝阁；Mac 从手机镜像增加本机捕获；iPad/Artifact 补齐入口。
- Real proof: Compose/SwiftUI/React 实现、双 flavor 编译、单测/lint、Mac typecheck/test/build、Share Extension build。

## Scope

- In scope: Android 搜索/筛选/详情/批量/分享/文件/Agent，iPad 拖放，iOS Artifact，Mac 本机捕获。
- Out of scope: Phase 3 阅读高亮/PDF 逐页/语义检索，Phase 4 增量跨端正文和附件同步。

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
