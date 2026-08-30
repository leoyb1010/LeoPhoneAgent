# Leo 藏宝阁三端升级总施工规范

> 文档状态：Approved for implementation planning
>
> 适用仓库：`https://github.com/leoyb1010/LeoPhoneAgent`
>
> 基线分支：`main`
>
> 基线提交：`33a5e08733952bb0b345f32bb9d1aa3a5c2eb2bb`
>
> 覆盖平台：iOS / iPadOS、Android Standard / Power、macOS LeoPhoneAgent
>
> 调研快照：2026-08-30
>
> 目标：把现有“收藏列表”升级为轻量、快速、跨端、可被 Agent 真正调用的个人知识资产库。

---

## 0. 远端开发 Agent 如何使用本文档

本文档是藏宝阁升级的唯一主施工规范。远端 Agent 开工前必须：

1. 阅读根目录 `AGENTS.md` 和 `README.md`。
2. 从主仓 `main` 的最新提交开始，先执行仓库状态检查，不得从 ZIP、旧副本或历史 worktree 开发。
3. 阅读本文第 1～8 节，确认当前能力、目标架构、统一数据契约和平台边界。
4. 严格按第 12 节阶段顺序施工；每个阶段都必须形成独立、可回滚、可验证的提交。
5. 不得把后续阶段的重型能力提前塞进首轮；不得为了“未来可能需要”添加新服务、新数据库或新依赖。
6. 改 Android 公共代码必须同时验证 Standard 与 Power；藏宝阁基础能力必须属于 Standard，不能依赖无障碍、Shizuku 或 Power 权限。
7. 未完成真机/模拟器验证时只能报告源码或编译验证，不能声称产品体验已经验收。
8. 除非用户另行要求，不改 HarmonyOS，不借本任务重构聊天、Provider、CLI 或 Relay 的无关模块。

本文档中的“必须”是验收条件；“建议”允许开发 Agent 依据实测调整；“暂缓”不得在首轮实现。

---

## 1. 产品结论

### 1.1 当前藏宝阁是什么

当前藏宝阁是 iOS 端独立的本机收藏与笔记库，已经支持：

- Share Extension 从任意 App 分享链接、文字、图片和文件；
- 剪贴板文本与短链识别；
- 新建笔记、扫描文档、相册导入、Files 导入；
- Vision 本机 OCR；
- 链接标题、封面、摘要和标签的惰性补全；
- SQLite FTS5 正文搜索和 Core Spotlight 元数据索引；
- 置顶、归档、批注、删除、多选；
- 应用内阅读和部分平台的原 App 深链；
- App Intent / Siri / 快捷指令“收进藏宝阁”；
- 将部分收藏发送到新 Agent 对话；
- 通过 Relay 将最多 500 条元数据上传给 Mac，只读展示。

主要代码入口：

| 能力 | 当前路径 |
|---|---|
| iOS 主页面 | `src/ios/Views/CollectionsView.swift` |
| iOS 条目模型与存储 | `src/ios/Shared/CollectionStore.swift` |
| 笔记正文与版本 | `src/ios/Shared/NoteBodyStore.swift` |
| FTS5 与 Spotlight | `src/ios/Shared/CollectionSearchIndex.swift` |
| 网页正文提取 | `src/ios/Shared/ArticleExtractor.swift` |
| 图片/文件/OCR | `src/ios/Shared/AttachmentImporter.swift` |
| 链接打开与短链解析 | `src/ios/Shared/CollectionOpener.swift` |
| 分享扩展 | `src/ios/ShareExtension/` |
| App Intent | `src/ios/Agent/Intents/CollectionIntents.swift` |
| iOS → Relay 元数据镜像 | `src/ios/Agent/Gateway/RelayEventCatchUp.swift` |
| Mac 只读镜像 | `src/mac/leocodebox/src/components/fleet/view/CollectionsMirror.tsx` |

### 1.2 当前最严重的产品断点

藏宝阁界面宣称“你的可调用记忆”，但实际还不是 Agent 可调用知识库：

1. 没有 `treasury_search`、`treasury_get`、`treasury_save` 等原生 Agent 工具。
2. 当前“发给 Agent”对笔记发送 `item.value`，而笔记正文实际在 `bodyFile`；因此笔记可能只发送空字符串。
3. 链接发送给 Agent 时主要发送 URL，没有稳定附带本地已抽取正文、摘要、标签、批注和来源。
4. Agent 无法主动回答“找出上周收藏的三篇文章并比较”。
5. Android 没有与 iOS 对等的藏宝阁数据层、页面、分享入口和 Agent 工具。
6. Mac 只有只读、最多 500 条的元数据快照；正文与附件不可读，也不能继续处理。
7. iOS 的 `items.json` 使用整库读写，适合早期个人数据，但不适合持续增长、分页、复杂过滤和跨端增量同步。
8. 正文抽取失败只在后台累计次数，用户看不到处理状态，也无法明确重试。
9. 缺少 URL/文件内容去重、导入导出、恢复与专项自动化测试。

### 1.3 正确产品定义

藏宝阁不是另一个 Notion，也不是纯书签管理器。它应当是：

> LeoPhoneAgent 的“通用捕获入口 + 本机知识资产库 + Agent 上下文供应器”。

核心闭环：

```text
随手收进来 → 原始内容立即安全落库 → 后台理解与索引
      → 人能快速找回 → Agent 能带引用地读取 → 继续产出或执行
```

### 1.4 成功标准

升级完成后，用户必须能自然完成以下任务：

- 在任意 App 分享一个链接，300ms 级感知反馈后返回原 App，不等待 AI。
- 截图、扫描件、PDF、文档、音频或聊天产出都能进入同一藏宝阁。
- 搜索“上周保存的安卓自动化项目”能命中标题、正文、OCR、转写、标签和批注。
- 在聊天里说“用我藏宝阁里的三篇 Fold8 适配资料给出方案”，Agent 能搜索、读取、引用来源并回答。
- iPhone、Android 和 Mac 都能看到一致的条目状态；正文与附件按隐私策略和用户动作按需同步。
- 任何抓取、摘要、OCR 或联网失败都不影响原始内容保存。
- 不启动常驻无障碍服务，不为藏宝阁引入持续耗电后台进程。

---

## 2. 设计原则与非目标

### 2.1 必须遵守的设计原则

1. **先保存，后理解**：原始内容落库成功是主事务；解析、OCR、摘要、标签、语义索引都是可重试增强任务。
2. **本机优先**：元数据、正文、附件、全文索引默认在本机。云端/Relay 只同步用户允许的范围。
3. **无标题也能保存**：捕获时不强迫用户选择标题、目录、标签或模型。
4. **平台原生**：iOS 使用 Share Extension、App Intents、Vision、Spotlight、Quick Look；Android 使用 Sharesheet、Room、WorkManager、SAF、系统快捷入口；Mac 复用现有 leocodebox 服务与 UI。
5. **一个领域模型，三个原生实现**：统一字段、状态机、工具协议和同步语义，但不强行共享 UI 框架或数据库代码。
6. **Agent 读取可解释**：搜索结果必须带条目 ID、来源、命中片段、更新时间和置信度；模型不能把推测当收藏事实。
7. **最小依赖**：优先使用仓库已有库和系统能力；只有现有能力无法达到验收指标时才新增依赖。
8. **明确恢复**：保存、处理、同步、删除都必须有可观察状态、重试或撤销路径。
9. **隐私最小化**：正文不自动进入 Spotlight；附件不默认上传 Relay；敏感内容不写日志。
10. **不牺牲流畅度**：列表滚动、搜索输入和主聊天不得被 OCR、WebView、数据库迁移或模型调用阻塞。

### 2.2 首轮明确不做

以下能力有吸引力，但会显著增加复杂度，首轮暂缓：

- 完整知识图谱和实体关系编辑器；
- 多人协作、公开分享社区、评论系统；
- 自建 Meilisearch、Elasticsearch、ChromaDB、pgvector 服务；
- 自动下载和长期保存所有在线视频；
- 24 小时剪贴板监听或截图监听；
- 依赖无障碍服务的收藏入口；
- 自动把所有收藏写入模型长期记忆；
- 复杂多层文件夹树；
- 为三端引入新的跨平台 UI 框架；
- 在藏宝阁任务中顺便重构聊天、Provider、CLI、Memory 或整个 Relay。

达到下列明确触发条件后才能重新评估：

| 暂缓能力 | 允许重新评估的触发条件 |
|---|---|
| 向量服务 | 本地收藏超过 5,000 条且 FTS + 轻量重排实测召回不足 |
| 完整知识图谱 | “相关收藏”点击率和用户需求证明关系浏览有持续价值 |
| 多人协作 | 出现明确第二用户/家庭共享需求与权限模型 |
| 全量视频归档 | 链接失效率或离线播放需求有真实数据支持 |
| 复杂目录树 | 单层合集 + 标签在真实数据中无法管理 |

---

## 3. 目标用户体验

### 3.1 捕获体验

#### 一步保存

- iOS/Android 分享面板默认显示“收进藏宝阁”。
- 点击后立即写入最小原始记录并显示成功，不等待标题抓取、OCR 或模型。
- 用户之前选择“默认收藏”时，不再弹二次选择；仍保留设置中切回“每次询问”。
- 保存成功反馈短、明确、可访问：图标 + “已收进藏宝阁”；触觉仅一次。
- 若检测到重复 URL 或文件，不再创建完全相同的第二份；提示“已收藏，已补充本次来源”。

#### 支持范围

| 输入 | 首轮处理 | 后台增强 |
|---|---|---|
| URL / 分享文案 | 保存原文、抽取 URL、来源 App | 短链解析、元数据、正文、摘要、标签 |
| 纯文本 / 选中文字 | 保存文本和来源 | 摘要、标签、语言检测 |
| 图片 / 截图 | 保存原图或受控压缩副本 | OCR、标题、可选视觉摘要 |
| 扫描件 | 自动裁边后的页面或 PDF | OCR、页码、摘要 |
| PDF | 保存文件和基础元数据 | 文本提取、逐页命中片段 |
| Office / Markdown / 代码 / CSV | 保存文件 | 可解析类型抽取文本与结构摘要 |
| 音频 / 语音备忘 | 保存音频 | 用户允许时转写、时间轴摘要 |
| 视频文件 / 视频链接 | 保存引用和基础信息 | 可用字幕优先；默认不全量下载视频 |
| 聊天产出 / Artifact | 保存受控文件引用或副本 | 继承会话、模型、生成时间和类型 |

#### 快捷入口

- iOS：Share Extension、App Shortcut、Siri、控制中心/操作按钮可组合的 App Intent、主页面快速入口。
- Android：Sharesheet、App Shortcuts、快捷设置磁贴、桌面小组件、新建入口；剪贴板读取必须由用户显式点击触发。
- Mac：菜单栏或应用内“收进藏宝阁”、文件拖放、浏览器 URL 粘贴、聊天产出“保存到藏宝阁”。

### 3.2 找回体验

藏宝阁首页优先展示“下一步能做什么”，而不是大面积统计数字。

推荐信息架构：

```text
藏宝阁
├── 搜索（自然语言 + 精确过滤）
├── 快速捕获
├── 智能视图
│   ├── 收件箱
│   ├── 处理中
│   ├── 待读
│   ├── 最近使用
│   └── 处理失败
├── 类型
│   ├── 链接 / 笔记 / 图片 / 文档 / 音视频 / 任务产出
├── 合集（单层）
└── 归档
```

搜索必须支持：

- 标题、URL、来源、摘要、标签、批注；
- 网页正文、笔记正文、OCR、PDF 文本、音频转写；
- 时间、类型、来源、合集、阅读状态、处理状态；
- 中文短词、拼音/英文混输不应让结果完全消失；
- 命中片段说明“为什么搜到”；
- 无结果时提供清除过滤条件或退回普通关键词的路径。

推荐过滤语法，同时保留可视化筛选：

```text
安卓自动化 tag:开源 type:pdf after:2026-07 unread:true
source:小红书 status:failed
kind:artifact session:当前项目
```

### 3.3 复用体验

每条收藏详情至少提供：

- 打开原内容；
- 应用内阅读/预览；
- 发给当前 Agent；
- 新建对话并引用；
- 复制引用或命中片段；
- 总结、比较、提取行动项；
- 加入合集、标签、置顶、待读、归档；
- 分享/导出；
- 查看来源、处理状态和同步状态。

多选后至少支持：

- 一次发给 Agent；
- 批量标签/合集/归档；
- 导出 Markdown/JSON；
- 删除并撤销。

---

## 4. 统一领域模型

### 4.1 `TreasureItem`

三端采用同一语义模型，但各端使用原生类型和数据库。字段名用于同步协议和 Agent 工具，不要求 UI 直接暴露。

```json
{
  "id": "uuid",
  "schema_version": 1,
  "kind": "link|text|note|image|document|audio|video|artifact",
  "title": "string|null",
  "source_uri": "string|null",
  "source_app": "string|null",
  "source_label": "string",
  "original_text": "string|null",
  "body_ref": "local-relative-reference|null",
  "preview_ref": "local-relative-reference|null",
  "mime_type": "string|null",
  "byte_count": 0,
  "content_digest": "sha256|null",
  "summary": "string|null",
  "annotation": "string|null",
  "tags": ["string"],
  "collection_ids": ["uuid"],
  "pinned": false,
  "archived": false,
  "reading_state": "unread|reading|read|none",
  "reading_progress": 0.0,
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "last_opened_at": "ISO-8601|null",
  "processing_state": "saved|queued|processing|ready|partial|failed",
  "processing_error_code": "string|null",
  "sync_state": "local|pending|synced|conflict|remote_only",
  "origin_device_id": "stable-device-id",
  "deleted_at": "ISO-8601|null"
}
```

### 4.2 字段约束

- `id` 创建后永不改变。
- `source_uri` 必须保存规范化前的原始可打开地址；另存规范化键用于去重，不能覆盖原值。
- `body_ref`、`preview_ref` 必须是受控根目录内的相对引用，不得接收任意绝对路径。
- `content_digest` 对文件内容计算；URL 使用独立 `normalized_url_key`，不能混用。
- `tags` 去空格、去重、大小写规范化，但保留用户可见写法。
- `deleted_at` 是跨端 tombstone；本地永久清理附件必须晚于同步保留期。
- `processing_error_code` 使用稳定枚举，不把完整异常、令牌、URL 查询参数写入同步或日志。
- `reading_progress` 限制在 `0...1`。

### 4.3 辅助实体

只增加真正需要的实体：

#### `TreasureCollection`

```text
id, name, icon, color_token, sort_order, created_at, updated_at, deleted_at
```

首轮只支持单层合集，不支持无限嵌套。

#### `TreasureChunk`

```text
item_id, chunk_index, section_label, text, start_offset, end_offset
```

用于正文分段、命中片段和可选语义检索。首轮不要保存复杂 DOM。

#### `TreasureJob`

```text
id, item_id, job_type, state, attempt_count, next_attempt_at,
created_at, updated_at, last_error_code
```

`job_type` 首轮仅限：

- `metadata`
- `extract_text`
- `ocr`
- `transcribe`
- `summarize`
- `tag`
- `index`
- `sync`

#### `TreasureTombstone`

删除同步可以直接使用 `TreasureItem.deleted_at`；只有数据库清理后仍需保留删除水位时才落独立 tombstone。不要同时维护两套互相竞争的删除真相。

### 4.4 数据库选择

- iOS：将 `items.json` 平滑迁移到现有可用的 SQLite 路径；允许直接使用 SQLite C API 或仓库已存在的数据层，不为此新增大型 ORM。
- Android：复用现有 Room `AppDatabase` 的迁移体系，新增实体/DAO/Repository。
- Mac：复用 leocodebox 现有数据库与服务层惯例；不要把所有收藏塞进 React 状态或单个 JSON 文件。
- FTS 继续使用平台 SQLite FTS5；不要引入远程搜索服务。

---

## 5. 处理状态机与恢复

### 5.1 状态机

```text
captured
   │ 原始内容原子落库
   ▼
 saved ───────────────► ready（不需要增强）
   │
   ▼
 queued ─► processing ─► ready
              │           ▲
              ├─► partial ┤  部分增强成功，可继续使用
              │
              └─► failed ─► queued（用户重试/退避重试）
```

### 5.2 强制规则

- 保存成功与增强成功必须分开报告。
- 原始内容落库后才允许关闭分享扩展或返回成功。
- 一个增强任务失败不能回滚已保存条目。
- 任务采用有限重试和指数退避；付费墙、登录页、格式不支持等永久错误不无限重试。
- App/进程被杀后任务状态必须可恢复，不能只存在内存布尔值。
- 用户必须能在“处理失败”视图看到失败项、原因分类和重试入口。
- 重新处理不能覆盖用户手写标题、标签、批注、阅读状态和合集。
- 同一条目的同类任务必须幂等，不能并发重复 OCR 或重复摘要。

### 5.3 推荐错误码

```text
unsupported_type
permission_denied
source_unreachable
source_requires_login
source_blocked
extract_empty
ocr_empty
transcription_unavailable
model_unavailable
storage_full
file_missing
integrity_mismatch
sync_unreachable
sync_conflict
unknown
```

UI 使用用户能理解的中文说明；日志和测试使用稳定错误码。

---

## 6. Agent 原生工具契约

### 6.1 为什么这是 P0

如果 Agent 不能主动搜索和读取，藏宝阁就只是收藏页。P0 必须先让“可调用记忆”名副其实，再做更复杂 UI。

### 6.2 最小工具集合

#### `treasury_search`

输入：

```json
{
  "query": "安卓自动化",
  "kinds": ["link", "document"],
  "tags": ["开源"],
  "source_labels": [],
  "collection_ids": [],
  "created_after": "2026-07-01T00:00:00Z",
  "created_before": null,
  "reading_state": "unread",
  "include_archived": false,
  "limit": 20
}
```

输出必须是紧凑搜索结果，不返回整篇正文：

```json
{
  "items": [
    {
      "id": "uuid",
      "title": "...",
      "kind": "link",
      "source_label": "GitHub",
      "created_at": "...",
      "snippet": "命中片段",
      "tags": ["开源"],
      "score": 0.87,
      "match_sources": ["title", "body"]
    }
  ],
  "truncated": false
}
```

#### `treasury_get`

输入：

```json
{
  "ids": ["uuid-1", "uuid-2"],
  "include_body": true,
  "include_annotations": true,
  "max_chars_per_item": 12000
}
```

输出要求：

- 每条内容保留来源 URI、标题、时间、摘要、正文片段和截断标记；
- 文件只返回受控引用和可安全提取内容，不把二进制塞进 JSON；
- 超出上下文时按相关段落截断，不偷偷丢掉全部正文；
- 缺失正文时明确 `body_status: missing|not_extracted|unavailable`。

#### `treasury_save`

允许 Agent 保存用户明确要求保留的内容或当前任务产出。写入必须经过现有工具权限/确认体系，不得让网页内容通过提示注入自行写入。

#### `treasury_update`

首轮只允许：标题、标签、合集、置顶、归档、阅读状态、批注。永久删除继续使用独立的高风险确认动作。

#### `treasury_attach_to_chat`

这是 UI 动作，不一定暴露给模型。它负责将选择的条目变成结构化上下文引用，而不是把所有正文拼成一条无边界字符串。

### 6.3 权限与提示注入防护

- 搜索和读取是本机用户数据访问，必须遵守现有 Agent 工具权限策略。
- 来自网页、PDF、OCR、音频转写的内容一律视为不可信数据，不得当系统指令执行。
- 工具返回使用清晰边界，例如 `<treasury_item>`，并在 Agent 系统规则中声明仅作资料。
- 保存/更新/删除不能由收藏内容中的命令触发，必须来自用户意图或已授权工具调用。
- 不在工具错误里暴露本地绝对路径、API Key、OAuth token、Relay Key。

### 6.4 “发给 Agent”根因修复

iOS 当前实现必须修正为：

- `note`：读取 `bodyFile` 正文，而不是发送空的 `value`；
- `link`：至少发送标题、URL、摘要、标签、批注；需要正文时走 `treasury_get`；
- `text`：发送原文和来源；
- `file`：复用受控附件管道，并附 MIME、标题和已提取文本；
- 多选：按条目边界构造结构化上下文；
- 附加提示与资料必须分字段，不能简单混成一段字符串。

---

## 7. 搜索与“更智能”的正确边界

### 7.1 第一层：结构化过滤

先按类型、日期、来源、标签、合集、阅读状态、归档和处理状态缩小范围。这一层确定、快速、可解释。

### 7.2 第二层：FTS5/BM25

- 索引标题、摘要、正文、OCR、转写、批注；
- 保留中文短词 LIKE 回退，但必须限制候选集，避免大库全表卡顿；
- 保存命中字段和 snippet；
- 索引损坏或 schema 变化时支持重建；
- 索引不是唯一真相，删除和迁移以主数据库为准。

### 7.3 第三层：可选语义召回

语义检索是增强，不是基础依赖：

- 默认不开独立常驻服务；
- 优先复用设备本机模型能力或用户已授权的兼容模型；
- 没有可用模型时，FTS 必须完整可用；
- 只对稳定正文 chunk 建索引；
- 内容更新后增量刷新；
- 远程 embedding 必须在设置里解释隐私范围并允许关闭。

### 7.4 排序

推荐轻量混合排序：

```text
final_score = RRF(keyword_rank, semantic_rank?)
            + pinned_boost
            + recent_use_boost
            + exact_title_boost
```

不要让“最近收藏”永久压过真正相关内容。搜索结果必须可解释地标出命中来源。

### 7.5 相关收藏

首轮使用简单可解释组合：共享标签、相同来源、正文关键词重叠、可选语义相似度。不要建立完整图数据库。

---

## 8. 三端平台落地规范

## 8.1 iOS / iPadOS

### 数据层

1. 为旧 `items.json` 增加只执行一次的 SQLite 迁移器。
2. 迁移前保留只读备份；迁移事务提交成功后才切换读取源。
3. 迁移必须兼容所有老字段缺失情况，不能因一个坏条目让整个库消失。
4. 附件、缩略图、笔记正文和版本文件保持受控目录；数据库只存相对引用。
5. 为 Share Extension 与主 App 保留跨进程一致性；SQLite 使用 WAL 和短事务，不在事务内联网或跑 OCR。

### 捕获

- 保留现有 Share Extension 双模式与默认动作设置。
- 分享扩展只完成解析输入、复制/移动原始内容、插入记录与排队；不在扩展进程跑 WebView、OCR 或模型。
- App Intent 继续支持后台收藏；新增的类型参数必须保持旧快捷指令兼容。
- PhotosPicker、Files、VisionKit 继续使用系统组件。
- 允许从聊天 Artifact 卡片一键保存，不重复复制已在受控目录的同一文件；使用引用计数或明确所有权规则。

### UI

- iPhone：单栏列表 + 搜索 + 筛选底部面板 + 紧凑捕获入口。
- iPad：`NavigationSplitView`，左侧智能视图/合集，中间列表，右侧详情/预览；窄窗口退化为单栏。
- 支持拖入 URL、文本、图片、PDF 和文件；支持把收藏拖到聊天输入区。
- 外接键盘至少支持搜索、新建笔记、快速捕获、打开、归档。
- VoiceOver、Dynamic Type、Reduce Motion 必须覆盖。

### 系统能力

- Core Spotlight 仅发布用户可理解的标题、摘要、标签和来源，不发布私密正文。
- Quick Look 预览支持的文件，不自造重复渲染器。
- App Intents 提供“收藏内容”“搜索藏宝阁”“打开藏宝阁”；“读取全文”不作为无确认的 Siri 对外朗读默认动作。
- iOS 后台受限，增强任务在 App 活跃时处理，并使用系统允许的后台任务补队列；不能承诺杀进程后立即完成。

## 8.2 Android Standard / Power

### 产品边界

- 藏宝阁完整基础能力必须在 Standard 可用。
- Power 可以复用相同藏宝阁，但不得增加独有数据格式。
- 藏宝阁不依赖 Accessibility、Shizuku、悬浮窗或忽略电池优化。
- 如果未来 Power 提供“把收藏交给其他 App 自动处理”，它属于独立自动化动作，仍必须经过权限与危险操作确认。

### 数据层

- 在现有 `AppDatabase` / Room 体系新增 Treasure 实体、DAO、Repository 和 Migration。
- 附件放入 App 私有受控目录；通过 SAF/ContentResolver 导入时及时持久化或复制，不长期依赖短期 URI 权限。
- FTS 使用 Room FTS 或平台 SQLite 能力；搜索与列表使用 Flow，不能每次输入都整库加载。
- WorkManager 负责持久增强队列、约束和退避；不要创建常驻前台服务来跑藏宝阁。

### 捕获

- 扩展现有 `ShareReceiverActivity.kt`，明确区分“发到对话”和“收进藏宝阁”。
- 支持 `ACTION_SEND` / `ACTION_SEND_MULTIPLE` 的 text/plain、image、PDF 和常用文档 MIME。
- 分享成功后立即结束透明 Activity；必要时用轻量状态页展示成功/失败，不启动完整聊天首页。
- App Shortcut、快捷设置磁贴、小组件使用同一个深链和捕获路由，避免多套实现。
- 剪贴板只能在用户点击时读取；不做后台监听。

### Fold8 与大屏

- 封面屏和普通手机：单栏，卡片宽度不挤压操作。
- 展开屏：列表/详情双栏；宽度足够时左侧增加智能视图/合集栏。
- 折叠切换必须保留搜索词、筛选、选中条目、滚动位置和未提交批注。
- 200% 字体下标题、状态、按钮不互相覆盖。
- 不以设备型号硬编码布局；使用窗口宽度级别、可用空间和折叠姿态。

### Android 原生智能增强

- 图片 OCR 优先使用现有可用的本机方案；若新增 ML Kit，必须说明包体与动态模型成本，并支持未下载模型时降级。
- PDF 和文档解析优先使用 Android 平台/已有依赖；不能为单一格式引入超大 SDK。
- 语音转写复用已有语音 Provider 或系统能力，用户未授权时保留原文件并显示“未转写”。

## 8.3 macOS LeoPhoneAgent

### 从镜像升级为工作台

现有 `CollectionsMirror.tsx` 不删除，先演进为独立 Treasure 工作区：

- 搜索手机与本机收藏元数据；
- 预览已同步或按需获取的正文；
- 一键发送给 Claude Code、Codex、Cursor、Grok 或 Leo 模型会话；
- 保存 Mac 本机文件、浏览器 URL、CLI 产出和聊天 Artifact；
- 清楚展示内容所在设备、是否可离线、是否需要从手机取回；
- 离线时保留最近成功索引并标记陈旧，不显示成最新状态。

### 服务层

- 在 `src/mac/leocodebox/server/modules/leophone/` 下扩展 Treasure API，遵循现有 harness auth 和错误封装。
- 元数据查询与正文/附件下载分开；列表 API 不返回大正文或二进制。
- 从手机按需获取正文/附件时校验条目 ID、byte count、digest、MIME 和最大尺寸。
- CLI Agent 通过统一 Treasure 工具访问，不让每个 Provider 各写一套收藏读取逻辑。
- `src/mac/leoagent/` 只在协议兼容确有需要时同步最小改动；主实现仍在 leocodebox。

### UI

- 使用桌面三栏：智能视图/合集、列表、详情。
- 支持拖放文件、粘贴 URL、键盘搜索、多选、右键操作。
- “发送到 Agent”先选现有/新会话与 Provider，但保留上次选择作为快捷动作。
- 大正文使用虚拟化或分段加载，不能一次塞入 React DOM。

---

## 9. 跨端同步与一致性

### 9.1 同步范围

默认分级：

1. **元数据同步**：标题、来源、摘要、标签、合集、状态、时间、digest。
2. **正文按需同步**：用户打开、搜索需要或显式选择“离线可用”时获取。
3. **附件按需同步**：默认不自动复制大文件；显示设备位置和可用性。

用户可在设置中选择：

- 仅本机；
- 同步元数据；
- 同步元数据和正文；
- 指定合集离线可用。

### 9.2 协议

当前“前 500 条整体快照”应迁移为游标增量协议：

```text
GET  /treasury/changes?after=<cursor>&limit=...
POST /treasury/changes
GET  /treasury/items/:id
GET  /treasury/items/:id/body
GET  /treasury/items/:id/assets/:assetId
```

每次变更至少包含：

```text
change_id, item_id, operation, updated_at, origin_device_id, payload_digest
```

### 9.3 冲突规则

- 删除 tombstone 优先于更早的更新。
- 不同字段允许字段级合并：例如 A 端加标签、B 端更新阅读进度。
- 同一自由文本字段双写时保留双方版本，显示冲突，不静默覆盖。
- 自动摘要、自动标签的写入不得覆盖用户编辑值。
- 附件 digest 相同视为同内容；digest 不同但 ID 相同视为冲突。
- 服务端和客户端都必须幂等处理重复 change。

### 9.4 安全

- 复用现有 Relay/Harness 鉴权，不新建第二套弱 token。
- 所有 ID、文件名、相对路径在服务端重新验证。
- 下载设置最大尺寸、超时和 MIME 白名单；压缩包不自动解压。
- 链接预览继续执行 SSRF 防护，拒绝本机、内网、元数据服务和伪装 IP。
- 同步日志不记录正文、查询词全文、附件内容和凭据。

---

## 10. UI、动效与可访问性规范

### 10.1 视觉层级

首页第一屏顺序：

1. 搜索；
2. 快速捕获；
3. 收件箱/处理状态；
4. 内容列表。

现有“内容/笔记/来源”统计卡不应长期占据第一屏，可缩成滚动后的概览或设置中的统计。用户进入藏宝阁的主要任务是保存、找回或复用，不是查看总数。

### 10.2 卡片信息预算

列表卡片默认只显示：

- 来源/类型；
- 标题；
- 1～2 行摘要或命中片段；
- 最多两个标签；
- 时间、阅读/处理状态中的必要一个。

其余动作进入滑动、长按、右键或详情。不要让每张卡片成为按钮墙。

### 10.3 动效预算

| 场景 | 建议 |
|---|---|
| 保存成功 | 180～220ms，内容缩成卡片/状态确认，一次轻触觉 |
| 卡片插入 | 淡入 + 轻微位移，不让整个列表弹跳 |
| 后台处理 | 卡片内状态更新，不循环大面积 shimmer |
| 去重 | 原卡片短暂高亮，提示“已补充来源” |
| 展开详情 | 平台原生 push/sheet/split transition |
| 删除/归档 | 退出后提供 5 秒撤销 |
| 批量选择 | 底部/顶部操作栏随状态出现 |

全部动效尊重 Reduce Motion / 系统动画比例。性能不足时优先保证输入、滚动和保存反馈，装饰动效可降级。

### 10.4 可访问性

- 图标按钮必须有可本地化标签；
- 处理状态不能只靠颜色；
- TalkBack/VoiceOver 朗读顺序为标题、来源、状态、摘要、操作；
- 200% 字体仍可操作；
- 键盘焦点、筛选、列表和详情顺序稳定；
- 所有中文页面在选择中文后不得残留英文功能按钮。

---

## 11. 开源能力吸收表与许可边界

调研项目只作为能力来源。复制代码前必须逐文件核验许可证、NOTICE 和依赖许可；“项目开源”不等于可以无条件复制。

| 项目 | 链接 | 可吸收能力 | 许可证/动作 |
|---|---|---|---|
| Karakeep | https://github.com/karakeep-app/karakeep | 万物收藏、移动离线、高亮、规则引擎、Agent/CLI、OCR、语义搜索 | AGPL-3.0；默认只学产品和架构，直接复制需履行完整义务 |
| Memos | https://github.com/usememos/memos | 无标题快速记录、时间线、轻标签、Web Clipper、API/Webhook | MIT；可选择性复用并保留版权与许可 |
| Linkora | https://github.com/LinkoraApp/Linkora | Android Compose、Room、本地优先、分享、WorkManager、导入导出、备份、大屏布局 | MIT；Android 首选工程参考 |
| Omnivore | https://github.com/omnivore-app/omnivore | iOS/Android 阅读器、离线变更、阅读进度、高亮、TTS | AGPL-3.0；学习状态机和交互，默认不复制实现 |
| Linkwarden | https://github.com/linkwarden/linkwarden | 网页 PDF/截图存档、批注、全文搜索、批量处理 | AGPL-3.0；学习产品机制 |
| Shiori | https://github.com/go-shiori/shiori | 轻量正文提取、离线网页存档、书签导入导出 | MIT；适合选择性复用算法/格式处理 |
| linkding | https://github.com/sissbruecker/linkding | 极简书签、标签自动完成、快速搜索、导入导出 | MIT；适合轻量交互与格式兼容 |
| Open Scanner | https://github.com/pencilresearch/OpenScanner | iOS 扫描库、Core Data/CloudKit 生命周期 | MIT；现有 VisionKit 足够时不要整套搬入 |
| OSS Document Scanner | https://github.com/ossappscollective/OSS-DocumentScanner | Android/iOS 扫描、页面处理、导出体验 | 复制前逐文件核验；优先使用系统扫描能力 |
| SuperBrain | https://github.com/sidinsearch/superbrain | Android 分享后分析、失败重试、重新浮现、视频/音频理解 | 仓库许可元数据不够清晰；只吸收概念 |
| 4DPocket | https://github.com/onllm-dev/4DPocket | 混合检索、过滤语法、RRF、相关内容、处理流水线 | GPL-3.0；默认只吸收架构，知识图谱首轮暂缓 |

### 吸收优先级

1. Linkora：Android 原生数据、分享、后台和大屏参考。
2. Memos：零摩擦捕获和轻组织。
3. Omnivore：阅读进度、高亮和离线变更模型。
4. Karakeep：Agent 工具、处理状态、规则和多类型范围。
5. Shiori/linkding：正文、导入导出和轻量管理。

任何 Agent 提议引入一个项目的完整服务栈时，必须先证明系统能力和当前仓库已有组件无法满足需求，并给出包体、内存、电量、许可和维护成本。

---

## 12. 分阶段施工计划

每阶段都必须：先测试旧行为 → 实现 → 定向测试 → 全量相关测试 → 审阅 diff → 独立提交。不要把五个阶段堆成一个巨型提交。

### Phase 0：修复“可调用记忆”断链

#### 目标

不改变现有存储架构，先让现有收藏内容能被正确发送和读取，为后续数据迁移建立行为基线。

#### 工作项

- 修复 iOS 笔记“发给 Agent”读取空 `value` 的问题；
- 为链接、文本、笔记、文件建立统一结构化上下文构造器；
- 新增最小 `treasury_search`、`treasury_get` 工具，先接 iOS 现有存储；
- 多选收藏一次发送给 Agent；
- 搜索结果带来源和命中片段；
- 加入提示注入边界和最大字符预算；
- 为当前 JSON/FTS 行为补回归测试。

#### 验收

- 笔记正文非空且与编辑器保存内容一致；
- 链接包含标题、URL、摘要、标签、批注；
- Agent 能搜索并读取指定条目；
- 10 条长文章不会未经控制全部塞进上下文；
- 工具调用失败不丢收藏、不崩溃。

实际交付证据：[Phase 0 可调用记忆修复与验证](TREASURY_PHASE0_DELIVERY_EVIDENCE.md)

### Phase 1：统一 SQLite 数据层与持久任务队列

#### 目标

建立三端长期可扩展的领域模型和状态机。

#### 工作项

- iOS `items.json` → SQLite 事务迁移和回滚；
- Android Room 实体、DAO、Repository、Migration；
- Mac 数据表与服务层；
- TreasureJob 持久队列；
- URL/文件去重；
- 索引重建；
- JSON/Markdown/浏览器 HTML 导入导出；
- tombstone 与基础增量 change 模型。

#### 验收

- 旧 iOS 库完整迁移，数量、附件、笔记正文、标签、批注、归档一致；
- 迁移中断后可安全重试；
- 1,000 条数据列表和搜索不整库解码；
- 重复 URL/相同文件不生成无意义副本；
- 进程被杀后队列可恢复；
- 三端能序列化/反序列化同一契约样本。

### Phase 2：Android 藏宝阁与三端捕获一致

#### 目标

Android Standard 获得完整独立藏宝阁；iOS、Android、Mac 捕获入口统一语义。

#### 工作项

- Android 主页面、详情、筛选、搜索、批量操作；
- `ShareReceiverActivity` 增加“收进藏宝阁”；
- URL、文本、图片、PDF、文件导入；
- WorkManager 元数据/OCR/索引任务；
- Android Agent 工具；
- Fold8 单栏/双栏/三栏自适应；
- Mac 本机文件/URL/Artifact 捕获；
- iOS Artifact 保存与拖放补齐。

#### 验收

- Android Standard 和 Power 行为一致；
- Standard 不出现 Power 权限依赖；
- Fold8 折叠切换不丢状态；
- 分享后无需打开聊天即可完成保存；
- 离线保存成功，联网后自动补增强；
- Android Agent 能搜索和读取本机藏宝阁。

### Phase 3：阅读、批注、处理状态与智能搜索

#### 目标

把收藏坟场变成能找回、能读完、能继续行动的知识工作台。

#### 工作项

- 收件箱、处理中、失败、待读、最近使用视图；
- 处理状态和重试；
- 阅读进度、文本高亮、定位批注；
- PDF 文本与逐页 snippet；
- 音频转写的可选管道；
- 精确过滤语法和可视化筛选；
- 可选语义召回 + RRF；
- 相关收藏；
- 批量交给 Agent 比较/总结。

#### 验收

- 失败项可见、可解释、可重试；
- 搜索结果展示命中原因；
- 没有语义模型时所有基础能力仍可用；
- 用户高亮/标签不被重新处理覆盖；
- 阅读进度跨端冲突可预测。

### Phase 4：增量同步与 Mac 主动工作台

#### 目标

替换 500 条只读快照，实现可恢复、按需、隐私分级的跨端能力。

#### 工作项

- 游标增量 changes API；
- 元数据同步、正文/附件按需获取；
- 冲突、tombstone、幂等和 digest；
- Mac 三栏工作台；
- Mac → CLI/Leo 模型一键引用；
- 断线、陈旧状态和恢复；
- 指定合集离线可用。

#### 验收

- 超过 500 条不丢数据；
- 断线重连不重复创建条目；
- 删除不会被旧快照复活；
- 附件损坏或 digest 不匹配时拒绝落盘；
- Mac 不联网时仍能查看上次成功的本地内容并明确标陈旧；
- 用户可控制正文和附件同步范围。

### Phase 5：打磨、审计与发布

#### 工作项

- 三端 UI/UX、动效、可访问性审计；
- 数据迁移、同步、权限、SSRF、路径和提示注入安全审计；
- 性能与电量回归；
- 删除死码、重复适配层和阶段性兼容代码；
- README、CHANGELOG、隐私说明、第三方许可、版本说明；
- Android 双 flavor、Fold8、覆盖安装、签名和 APK 摘要门禁；
- iOS iPhone/iPad 模拟器与用户真机安装包验证；
- Mac 打包、签名、公证、热更新和回滚验证按现有发布流程执行。

#### 交付条件

第 13～16 节全部满足才允许公开发布。

---

## 13. 测试矩阵

### 13.1 数据层

- 新库创建；
- 所有历史 schema 样本迁移；
- 单个坏条目隔离；
- 迁移中断与重试；
- App 与 Share Extension 并发写；
- 大文件导入空间不足；
- 附件缺失、digest 不匹配；
- URL 规范化与去重；
- 相同内容不同文件名去重；
- 删除、撤销、tombstone、清理；
- 索引重建不改主数据；
- 导入/导出往返一致。

### 13.2 捕获链路

三端分别覆盖：

- 浏览器 URL；
- 小红书/抖音等“文案 + 短链”；
- 纯文本；
- 单图、多图；
- 扫描件；
- PDF；
- Markdown/CSV/代码；
- 音频；
- 聊天 Artifact；
- 不支持 MIME；
- 权限拒绝；
- 离线；
- 进程被系统杀死。

### 13.3 搜索

- 中文 1/2/3 字词；
- 英文大小写；
- 标题、正文、OCR、批注、标签分别命中；
- 多过滤器组合；
- 归档默认排除；
- 空查询、特殊字符、超长查询；
- 索引未完成与重建中；
- 语义模型不可用降级；
- 搜索取消、防抖和快速连续输入。

### 13.4 Agent

- `search → get → answer`；
- 多选引用；
- 正文截断；
- 文件缺失；
- 权限拒绝；
- 网页正文中的提示注入；
- 用户要求更新/归档；
- 未明确要求时不得永久删除；
- 输出必须包含可追踪来源。

### 13.5 UI 与设备

#### iOS/iPadOS

- iPhone 小屏、标准屏、大屏；
- iPad 竖屏、横屏、分屏、台前调度、窗口缩放；
- Dynamic Type 最大尺寸；
- VoiceOver；
- Reduce Motion；
- 深色/浅色；
- 拖放与键盘。

#### Android

- Standard / Power；
- API 26 最低版本与当前 target；
- Fold8 封面屏 `1080×1728`；
- Fold8 展开屏 `1768×2208`；
- 折叠过程中状态保留；
- 200% 字体；
- TalkBack；
- 预测性返回；
- 进程死亡与 WorkManager 恢复。

#### Mac

- 窄窗口、标准窗口、全屏；
- 键盘和拖放；
- 手机在线/离线；
- Relay 断线、超时、过期快照；
- 大正文和大附件；
- 发送至四种 CLI 和 Leo 模型。

### 13.6 跨端

- iOS 创建 → Android/Mac 看见；
- Android 更新标签 → iOS/Mac 看见；
- 双端同时编辑不同字段；
- 双端同时编辑批注；
- 一端删除、另一端离线后恢复；
- 元数据同步但正文禁用；
- 指定合集离线可用；
- 重复 change、乱序 change、游标过期；
- 附件断点/重试与 digest。

---

## 14. 性能、电量与容量指标

| 指标 | 目标 |
|---|---|
| 分享后成功反馈 | 感知 P95 ≤ 300ms，不含附件物理复制时间 |
| 1,000 条本地库首屏 | P95 ≤ 400ms |
| 关键词搜索 | 1,000 条 P95 ≤ 150ms；10,000 条 P95 ≤ 300ms |
| 列表滚动 | 主流设备保持可感知流畅，无 OCR/摘要主线程卡顿 |
| Agent search 工具 | 本地 P95 ≤ 500ms，不含模型生成 |
| 正文按需读取 | 遵守字符预算，不能一次装载无限内容 |
| 后台任务 | 无 24 小时常驻服务；系统调度、约束和退避 |
| 附件空间 | 设置页可查看占用并按类型清理缓存，不误删原始条目 |
| 同步 | 增量、分页、幂等；不得每次上传整库 |

性能测试使用脱敏生成数据。不得把真实用户收藏上传到基准服务。

---

## 15. 安全、隐私与数据完整性门禁

发布前逐项确认：

- [ ] 分享扩展与主 App 并发不会丢条目。
- [ ] 数据迁移失败保留原始库与可恢复副本。
- [ ] 所有附件路径限制在受控根目录。
- [ ] URL 抓取具备 SSRF、重定向、DNS/IP 和超时防护。
- [ ] HTML/Markdown/网页正文按不可信内容处理。
- [ ] Agent 工具输出不会把收藏内容提升为指令。
- [ ] Spotlight 不包含私密正文。
- [ ] Relay 日志不含正文、附件、密钥和敏感查询。
- [ ] 大文件、压缩包和 MIME 有上限与校验。
- [ ] 自动标签/摘要不会覆盖用户编辑。
- [ ] 删除可撤销，跨端有 tombstone，旧快照不能复活内容。
- [ ] 同步正文/附件前有明确设置与范围说明。
- [ ] Android Standard 不请求藏宝阁不需要的高权限。
- [ ] iOS Share Extension 不在受限进程内执行重型处理。

---

## 16. Definition of Done

只有同时满足以下条件，才可称“藏宝阁三端升级完成”：

### 产品

- [ ] iOS、Android、Mac 都能独立捕获、搜索、查看和交给 Agent。
- [ ] Android Standard 不依赖 Power 权限。
- [ ] iPad 与 Fold8 有真实自适应工作流，不只是拉宽单栏。
- [ ] 失败、处理中、离线、冲突和陈旧状态用户可理解。
- [ ] 中文模式所有藏宝阁按钮、筛选、状态和错误均为中文。

### 数据

- [ ] 旧 iOS 收藏无损迁移。
- [ ] SQLite/Room/Mac 数据模型符合统一契约。
- [ ] 去重、导入、导出、恢复、删除、增量同步均有测试。
- [ ] 正文和附件同步范围可控。

### Agent

- [ ] `treasury_search/get/save/update` 契约一致。
- [ ] 笔记正文、链接正文、OCR、PDF 和转写可以受控引用。
- [ ] 搜索结果有来源与命中片段。
- [ ] 提示注入和权限测试通过。

### 质量

- [ ] iOS 单元/UI 测试与 iPhone/iPad 定向验证通过。
- [ ] Android Standard/Power 编译、单元、lint、仪器测试通过。
- [ ] Fold8 冷启动、折叠切换、200% 字体和 Logcat 扫描通过。
- [ ] Mac typecheck/test/build 与真实界面验证通过。
- [ ] 性能和电量指标达到第 14 节目标或记录了经用户接受的偏差。
- [ ] 两轮最终审计：第一轮正确性/安全/数据；第二轮产品/UI/动效/冗余。

### 仓库与发布

- [ ] README、CHANGELOG、隐私说明、第三方许可同步。
- [ ] 无未提交、未 push、未合并的相关变更。
- [ ] Android 发布遵守签名、覆盖安装、双 flavor、Fold8 和摘要铁律。
- [ ] iOS 与 Mac 只报告已有证据，不虚报真机、签名、公证或热更新结果。
- [ ] GitHub Release 附件、版本号、摘要和源码对应同一提交。

---

## 17. 推荐提交拆分

建议最少拆为以下可回滚提交，实际可再按平台细分：

```text
fix(treasury): send complete structured items to agent
feat(treasury): add searchable agent tool contract
feat(ios-treasury): migrate collection store to sqlite
feat(android-treasury): add local library and share capture
feat(mac-treasury): replace read-only mirror with workspace
feat(treasury): add persistent enrichment jobs and retry states
feat(treasury): add filters reading state and highlights
feat(treasury-sync): add cursor changes and on-demand assets
test(treasury): cover migration sync injection and device flows
docs(treasury): publish cross-platform delivery evidence
```

禁止把所有平台和阶段压成一个无法审查的巨型提交。协议变更必须与对应消费者测试同提交或紧邻提交。

---

## 18. 风险清单与默认决策

| 风险 | 默认决策 |
|---|---|
| iOS JSON 迁移丢数据 | 事务迁移 + 原文件备份 + 数量/digest 校验后切换 |
| Share Extension 与 App 并发 | SQLite WAL + 短事务；重任务出扩展进程 |
| AI 导致保存变慢 | AI 永远后台增强，原始保存不等待 |
| 语义搜索增加包体/耗电 | 默认 FTS；语义层可选、懒索引、可关闭 |
| Android 后台耗电 | WorkManager 约束和退避，不用常驻服务 |
| Mac 同步泄露隐私 | 默认元数据；正文/附件按需、可关闭 |
| AGPL/GPL 污染不清晰 | 默认只学架构；复制前单独许可审查 |
| 同步冲突覆盖用户内容 | 用户字段优先、字段级合并、文本双写保留双方 |
| 大文件拖垮同步 | 元数据与附件分离、尺寸上限、按需下载、digest |
| 模型被收藏内容提示注入 | 内容作为不可信资料封装，工具权限与用户意图独立 |
| 产品变成第二个 Notion | 单层合集、轻标签、智能视图；暂缓图谱与协作 |

---

## 19. 远端开发机开工清单

```sh
git status --short --branch
git remote -v
git fetch --prune --tags origin
git rev-list --left-right --count HEAD...origin/main
git pull --ff-only origin main
git submodule update --init --recursive
```

然后：

1. 记录实际开始提交，不要假设仍是本文档基线提交。
2. 先运行当前 iOS/Android/Mac 与藏宝阁相关的现有测试，建立红绿基线。
3. 从 Phase 0 开始，不跳到 UI 大改或跨端同步。
4. 每完成一个阶段，在本文档对应阶段下新增“实际交付证据”链接或另建同目录交付报告。
5. 如果实现与本文档发生冲突，优先修正文档并记录理由，不允许代码和计划长期分叉。
6. 任何发布动作继续遵守仓库根 `AGENTS.md` 和 README 的发布铁律。

---

## 20. 最终原则

藏宝阁的升级重点不是堆更多卡片、更多 AI 按钮或更复杂的目录，而是把四个动作做到极致：

```text
收得快  →  原始内容先安全落库
找得到  →  关键词、过滤和可选语义都能解释命中
用得上  →  Agent 能受控读取、引用、组合和继续执行
不添乱  →  不常驻耗电、不泄露隐私、不让三端各自长成三套产品
```

远端 Agent 应以每轮“真实可见、可验证、可回滚”的产品增量推进，而不是以代码量、页面数量或模型调用次数衡量完成度。
