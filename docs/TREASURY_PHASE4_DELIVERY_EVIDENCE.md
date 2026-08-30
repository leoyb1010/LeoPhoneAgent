# Phase 4 交付证据：增量同步与 Mac 主动工作台

## 结论与完成比例

Phase 4 的本机可实现源码、自动化和 Mac 真实浏览器验证已完成。旧的“前 500 条整体镜像”已替换为游标增量 changes；元数据、正文和附件分层同步；iOS、Android、Mac 均能上传本地变更、拉取远端变更、处理 tombstone，并按需提供正文或附件。Mac 已从只读镜像演进为可捕获、搜索、阅读、离线缓存和引用到新对话的主动工作台。

- 本机源码与自动化范围：**100%**。
- Phase 4 全验收范围：**82%**。尚缺三端真实联网互操作、移动设备离线恢复、Fold8/iPhone/iPad 设备体验和附件 Range 断点续传证据。
- 发布状态：**HOLD**。本阶段只提交并 push 源码，不发布 APK、IPA、DMG 或热更新。

## 用户可见变化

### iOS / iPadOS

- Relay 同步从整体快照切换为 `changes` 游标：本机变更分页上传，远端变更分页拉取；游标过期时通过分页 items 重建。
- 本机收藏按元数据同步；正文与附件只在 Mac/其他端明确请求时上传，原始文件不会因为同步或增强失败而删除。
- 同步合同区分 `body_available` 与 `attachment_available`。聊天 Artifact 有文件引用时声明附件可用，只有确有原始文字时才声明正文可用。
- 同步时间统一保留毫秒级精度；本地 pending 与同毫秒远端修改稳定进入 conflict，不受 SQLite 子毫秒精度或 ISO-8601 整秒截断影响。
- UUID、文件名、byte count、digest、MIME、正文 8 MB 和附件 128 MB 上限均在上传前验证。

### Android Standard / Power

- 新增 `TreasurySyncClient`，由现有 WorkManager 调度执行上传、拉取、游标重建和来源设备资产请求；没有新增常驻前台服务或 Power 权限依赖。
- Room 变更日志提供真实递增 sequence；远端 change 以 change ID、时间、删除优先级、来源设备和 change ID 做可预测排序。
- 重复 change 幂等，乱序旧 change 不覆盖新状态；本机 pending 与并发远端修改标记 conflict；旧更新不能复活 tombstone。
- 正文和附件从应用私有目录按需提供，上传前复核安全文件名、大小、digest 和记录中的 byte count/digest。
- Artifact 的正文/附件可用性与真实保存内容一致，避免二进制 Artifact 被错误声明为“有正文、无附件”。

### Mac

- CollectionsMirror 演进为桌面三栏工作台：智能视图/合集、Mac 与手机条目列表、正文/附件详情。
- 可在 Mac 本机保存 URL、文字和文件；列表 API 不返回大正文或二进制，详情和附件单独按需读取。
- 手机离线或 Relay 断线时保留最后成功元数据、正文和附件缓存，并明确显示“陈旧”状态。
- 用户可以选择“仅本机”“同步元数据（正文/附件按需）”“同步元数据和正文”；也可将指定合集设为离线正文。附件始终保持逐条按需。
- 本机和手机收藏都可引用到新对话。引用正文限制 20,000 字符、明确 `body_truncated`，并放入 `untrusted=true` 边界；`<`、`>`、`&` 使用 Unicode escape，收藏中的恶意文字不能闭合资料边界或变成系统指令。
- 没有项目时，引用动作打开已有项目选择抽屉，并通过现有 pending prompt 槽保留待发送内容。

## 数据与协议变化

### Relay changes

新增并持久化：

```text
GET  /relay/api/treasury/changes?after=<cursor>&limit=<n>
POST /relay/api/treasury/changes
GET  /relay/api/treasury/items?after_sequence=<cursor>&limit=<n>
POST /relay/api/treasury/assets/requests
GET  /relay/api/treasury/assets/requests?origin_device_id=<id>
PUT  /relay/api/treasury/assets/:requestId
GET  /relay/api/treasury/assets/:requestId
POST /relay/api/treasury/assets/:requestId/unavailable
```

- change 至少包含 `change_id`、`item_id`、`operation`、`updated_at`、`origin_device_id`、`payload_digest` 和本机 sequence。
- Relay 保存最多 50,000 条近期 change、200,000 个幂等 change ID，并对旧游标返回 410，客户端随后执行分页快照重建。
- LWW 排序键为更新时间、删除优先级、来源设备 ID、change ID；服务端 sequence 只用于稳定增量游标。
- 元数据与资产分离；正文上限 8 MB，附件上限 128 MB，请求最长保存 30 天。
- 附件 MIME 使用明确允许列表；非通用 MIME 必须与元数据一致。下载与落盘前复核 byte count、SHA-256、MIME 和目标目录边界。

### iOS SQLite

- `treasure_changes` 查询返回 rowid sequence，支持分页上传。
- 增加远端 change 应用、sync contract 和按需资产读取。
- 远端 upsert 保留已成功缓存但本轮元数据未携带的正文/附件引用；远端缺正文不能清空已有有效正文。
- 删除不存在条目时写入最小 tombstone，阻断后到的旧 upsert。

### Android Room

- DAO/Repository 增加带 sequence 的变更读取、包含 tombstone 的合同读取、远端 change 应用和资产提供。
- 本阶段没有增加 Room schema version；复用 Phase 1–3 已交付的 change、sync state、digest 和 tombstone 字段。

### Mac SQLite

- 增加 `treasure_remote_items`、`treasure_sync_cursors`、`treasure_remote_assets`，分别持久化远端元数据、下载/上传游标和已校验资产缓存。
- 远端列表按 server sequence 幂等 upsert；410 重建在事务中替换同一 scope 快照。
- 公开 `/api/auth` 路由先于广泛 `/api` 鉴权挂载，避免登录初始化被错误拦截；Treasury API 仍使用现有本机认证。

## 三轮审计与修复

### 第 1 轮：Mac UI、交互与 Agent 引用

修复：

- Mac 本机条目缺少“引用到新对话”，只有手机条目能使用。
- 长正文引用没有统一字符预算和截断标记。
- 收藏正文可用 XML 风格文本提前闭合 `<treasury_item>` 边界。
- 无项目时引用内容可能在项目选择过程中丢失。

真实浏览器验证了本机文字捕获、智能视图、搜索、详情、阅读状态、高亮、宽/窄布局和项目选择衔接；页面无横向溢出。

### 第 2 轮：同步、安全与资产完整性

修复：

- iOS/Android 二进制 Artifact 的正文/附件 availability 声明错误。
- Relay 和 Mac 下载端只检查 MIME 非空，缺少允许列表。
- 附件上传没有强制非通用 MIME 与元数据一致。
- iOS `deleteHighlight` SQLite statement 未及时 finalize，触发 API violation 风险。

复核没有在错误、日志或响应中暴露 API Key、OAuth token、Relay Key或本机敏感绝对路径。

### 第 3 轮：冲突精度、隐私范围与恢复边界

修复：

- iOS conflict 测试偶发 pending：根因是 SQLite 子毫秒值、Android/Relay 毫秒值和设备 ID tie-break 混用。现统一按协议毫秒精度比较。
- iOS sync contract 与 410 快照把时间格式化到整秒，可能在重建后重新制造精度偏差。现统一使用带小数秒 ISO-8601。
- Mac 缺少“仅本机 / 元数据 / 元数据+正文”的同步范围选择；现已持久化并在“仅本机”时停止展示和刷新手机内容。
- “元数据+正文”和指定合集离线预取均有 200 条单轮上限、4 路并发和完整缓存复核；附件不被自动批量下载。

复核结论：没有恢复整库上传，没有新增常驻服务，没有把全部附件自动复制到 Mac，也没有让外部收藏文字取得工具授权。

## 自动化验证

### iOS / iPadOS

- `MinisLogicTests`：**304/304 passed**，0 failed，iPhone 17 / iOS 26.5 Simulator。
- conflict 定向回归连续运行 3 次均通过；随后全量测试通过。
- `MinisShare` iOS Simulator target：build succeeded。
- 主 App scheme 仍因本机缺少 watchOS 26.5 runtime 无法完整构建，准确标记 HOLD。

### Android

已执行并通过：

```text
./gradlew --no-daemon \
  compileStandardDebugKotlin compilePowerDebugKotlin \
  testStandardDebugUnitTest testPowerDebugUnitTest

./gradlew --no-daemon lintStandardDebug lintPowerDebug
```

- 双 flavor 编译和 JVM 单测通过。
- lint：0 errors；538 个仓库既有 warnings、38 hints。
- Artifact availability 定向测试在 Standard/Power 均通过。

### Relay

- `python3 -m unittest -v leoagent.test_relay_security`：**12/12 passed**。
- 覆盖 change 幂等/排序/重启恢复、旧 500 快照迁移、拒绝 change 时 ack 不越过、资产按需、digest/byte count、MIME 拒绝与不一致拒绝。

### Mac

- `npm run typecheck`：通过。
- `npm run test:client`：**160/160 passed**。
- `npm run test:server`：**392/392 passed**。
- `npm run build`：client/server production build 通过。
- 真实浏览器：宽窗口、窄窗口、三栏退化、捕获、搜索、详情、阅读、高亮、引用和同步范围控件渲染通过。

## 明确边界与 HOLD

- 没有实现 HTTP Range 分块续传。当前附件支持完整文件失败重试、临时文件、原子落盘和 digest 校验；不得写成“已完成断点续传”。
- iOS → Android/Mac、Android 更新 → iOS/Mac、双端并发编辑、离线删除恢复、重复/乱序 change 和附件下载的真实三设备联网矩阵仍需用户测试环境执行。
- Fold8 封面/展开/折叠切换、API 26、200% 字体、TalkBack、预测性返回、进程死亡恢复仍为 HOLD。
- iPhone/iPad 主 App、VoiceOver、Dynamic Type、Reduce Motion、拖放、多窗口和真机 Relay 恢复仍为 HOLD。
- Android 固定签名、上一版本覆盖安装、Logcat、版本号、APK digest 和发布仍为 HOLD。
- iOS 签名、Archive、真机安装和发布仍为 HOLD。
- Mac 真实 Electron Relay 在线/离线双机、四种 CLI 与 Leo 模型实际发送、签名、公证和热更新仍为 HOLD。
- 本阶段不发布任何安装包；用户设备验证前不宣称 Phase 4 已公开发布。

## 实际修改范围

- Android：Treasure DAO/Repository、WorkManager 同步调度、`TreasurySyncClient` 和资产测试。
- iOS：`CollectionStore`、Relay catch-up/sync、Phase 4 逻辑测试。
- Relay：changes/items/assets 协议、持久状态、安全校验和安全测试。
- Mac server：数据库 schema/repository、Fleet/Treasury routes、auth 路由顺序和测试。
- Mac client：三栏工作台、同步范围、离线合集、引用到新对话、项目选择衔接和 prompt 测试。

## 下一阶段

Phase 5 将进行最终 UI/UX、可访问性、安全、性能、电量和冗余代码审计，更新 README、CHANGELOG、隐私说明与施工规范，并输出用户测试环境的真机/签名/覆盖安装清单。任何无法在本机取得的发布门禁继续保持 HOLD。
