# 原生中文 Paperclip 工作台

基于官方 Paperclip 994d6edc。默认桌面入口直接挂载服务器工作台，不等待 Local Host 或本地数据库；用户明确进入「本地历史恢复」才使用旧 Root/Host 链。返回服务器不销毁已由用户启动的本机会话。

```text
UI hook → 单一 Paperclip 客户端协调者 → IPlatformService.paperclip → preload 固定 IPC
                                                    ↓
                           Main 隔离 Cookie / 登录窗口 / 下载 IO → Paperclip 服务器
配置命令 → Main 已有 settingService → 非敏感 origin / origin+user 的公司选择偏好
```

服务器拥有任务、评论、审批、运行和附件。服务只拥有身份代际、读取投影、未确认提交回执；UI 只拥有筛选、选择和草稿。Paperclip 的 origin/user/company 身份不伪装成文件 workspacePath，不走 CLI/Git 或 remote workspace 注册表。

HTTPS origin 允许连接；HTTP 仅限显式本机 loopback。人类身份必须经 BetterAuth `/auth` 登录并验证 `/api/auth/get-session`，不能以 Agent Key 替代。切 origin、账号或公司时推进 generation，迟到响应不能覆盖新投影。写操作先绑定 origin/user/company，单次发送；响应丢失、5xx 或不兼容回执保留未知状态，禁止自动重发。创建使用 UUID idempotencyKey，首次提交时间持久化在身份隔离草稿内；官方去重仅保留 7 天，过期或旧草稿无可信时间禁重发并保留内容。评论使用 clientRequestId。

最小闭环：配置 → 登录 → 选公司 → 任务列表/分页/创建 → 详情/评论/状态 → 关联审批/决定 → 历史运行/日志/取消 → 来自当前任务附件清单的受控 contentPath 下载。下载必须重新确认当前任务/附件来源，只接受原生已有 attachments/assets 路径并使用系统另存为。外部 work-product URL 不伪装成可下载产物。

验收：无 Host 可显示配置页；登录取消后重入；401/403/网络错误有中文反馈；切公司/退出后的迟到读取被丢弃；未知写不自动重试；7 天创建期限不被重试刷新；附件来源及路径校验；局部 service 测试，Renderer 构建、typecheck/lint/architecture，实际 Electron 服务登录与操作验证。真实服务器/真机证据单独记录，不以静态或 fixture 验证替代。
