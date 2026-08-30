# 藏宝阁隐私与安全说明

最后更新：2026-08-31

## 本机优先

- URL、文字、笔记、图片、截图、扫描、PDF、文档、音频/视频引用和聊天 Artifact 的原始保存不依赖 OCR、摘要、模型或 Leo 运营的服务器。
- 保存、后台处理和同步是独立状态。OCR、提取、索引、摘要或同步失败不会删除已保存原始内容。
- 正文、附件、阅读进度、高亮、批注、处理状态和变更日志保存在各平台的应用私有数据库/目录中。
- 藏宝阁不增加 24 小时剪贴板/截图监听、常驻无障碍服务、常驻搜索服务器或默认下载全部在线视频。

## Agent 读取与写入

- `treasury_search` 只返回紧凑来源结果；`treasury_get` 按条目和字符预算读取，并明确正文缺失、未抽取、未获取、不可用和截断状态。
- 网页、PDF、OCR、音频转写、外部文件和收藏内容全部是不可信资料，不会被当作系统提示或权限指令执行。
- 只有用户明确要求或已批准写工具调用时，`treasury_save` / `treasury_update` 才能执行。永久删除不属于 `treasury_update`，继续要求独立高风险确认。
- iOS/Android 会读取当前真实用户消息，再检查明确意图、否定表达和提示注入 marker。
- Mac MCP 服务无法读取 CLI 原始用户消息，因此写入必须同时经过 Provider 客户端的写工具审批并携带 `user_confirmed=true`；服务端再限制 URL、字段、大小和删除能力。
- 工具错误不会返回 API Key、OAuth token、Relay Key 或本机敏感绝对路径。

## 同步与缓存

- 配置用户自己的 Leo Relay 后，三端使用游标增量 changes，不在每次同步上传整库。
- 元数据、正文和附件分层。正文和附件默认按需获取；Mac 可选择仅本机、元数据或元数据+正文，并可指定合集离线正文。
- 附件和远端正文使用大小、byte count、SHA-256、MIME 和受控路径校验；损坏或不匹配内容被拒绝。
- tombstone、change ID 和游标用于防止重复创建、乱序覆盖和旧内容复活。手机离线时 Mac 可保留最后成功缓存并标记陈旧。
- 当前没有 HTTP Range 分块续传；大附件使用完整文件失败重试、临时文件、原子落盘和完整 digest 校验。
- 三端存储管理明确区分原始内容与可再生/可重新下载缓存。清理缩略图、同步 outbox、远端正文或附件缓存不会删除收藏、正文文件、批注或本机原始附件。
- 缓存统计和清理限制在应用受控根目录，拒绝符号链接根目录、realpath 越界和特殊文件；Mac 原始目录只读统计，Android 只允许清理 `treasury/sync-outbox`。

## 平台权限

- iOS Share Extension 只负责原始保存和任务排队，不在受限扩展进程运行 WebView、OCR 或模型；图片/文件优先保留原始字节，只有暂存成功才登记附件，增强失败不会制造假成功记录。
- iOS Spotlight 只接收明确标题、来源和用户标签，不接收原始正文、原始 URL 或生成摘要，避免敏感 query 和私密内容离开应用内索引边界。
- Android Standard 的藏宝阁不依赖 Accessibility、Shizuku、悬浮窗或 Power 权限；后台增强使用 WorkManager，不新增常驻前台服务。
- Mac 复用 leocodebox 本机认证、数据库和 Provider MCP 体系。MCP token 加密存储，stdio 文件镜像权限为 `0600`。

## 保留与删除

- 删除 Relay 配置会停止后续同步，但不会自动删除设备本机或已缓存副本。
- 用户删除收藏或应用数据后，本机内容按平台删除机制移除；跨端删除通过 tombstone 传播。
- 永久删除属于高风险操作，不由普通 update 工具隐式触发。
- 诊断和错误信息只记录必要状态，不应包含原始正文、附件内容、密钥或敏感查询。

## 第三方与网络

- 只有用户明确把藏宝阁内容交给 Agent 时，选中的内容才会发送到用户配置的 AI Provider，并受该 Provider 的隐私条款约束。
- 本阶段没有新增第三方运行时依赖。现有依赖和许可证见 [`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md)。
- 可选语义检索和音频转写当前未启用，不是基础搜索或保存能力的依赖。

## 尚待设备验证

真实 iPhone/iPad、Fold8/API 26/TalkBack/200% 字体、三设备联网、签名、覆盖安装、Mac 新存储页登录后走查/双机 Relay、屏幕阅读器、公证和热更新仍需在对应环境执行。详见 [`TREASURY_DEVICE_RELEASE_CHECKLIST.md`](TREASURY_DEVICE_RELEASE_CHECKLIST.md)。
