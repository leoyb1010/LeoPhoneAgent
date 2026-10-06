# 原生中文 Paperclip 工作台

基于官方 Paperclip 994d6edc。桌面默认打开**本机工作台**（Root + Local Host）；服务器工作台是本机侧栏里的「服务器任务」入口，工作台标题栏与侧栏都有「返回本机工作台」。窗口记住上次的选择（renderer `localStorage` 键 `leo-workspace-mode`，首次启动为本机；URL `workspaceMode=server|local` 只作显式覆盖，旧的 `local-recovery` 等同本机）。不论显示哪个，Local Host 都常驻（手机连接、藏宝阁、订阅代理、定时任务）；服务器视图只是不消费本机业务端口。实现见 `packages/desktop/src/renderer/src/workspaceMode.ts`。

```text
UI hook → 单一 Paperclip 客户端协调者 → IPlatformService.paperclip → preload 固定 IPC
                                                    ↓
                           Main 隔离 Cookie / 登录窗口 / 下载 IO → Paperclip 服务器
配置命令 → Main 已有 settingService → 非敏感 origin / origin+user 的公司选择偏好
```

服务器拥有任务、评论、审批、运行和附件。服务只拥有身份代际、读取投影、未确认提交回执；UI 只拥有筛选、选择和草稿。Paperclip 的 origin/user/company 身份不伪装成文件 workspacePath，不走 CLI/Git 或 remote workspace 注册表。

HTTPS origin 允许连接；HTTP 仅限显式本机 loopback。人类身份必须经 BetterAuth `/auth` 登录并验证 `/api/auth/get-session`，不能以 Agent Key 替代。切 origin、账号或公司时推进 generation，迟到响应不能覆盖新投影。写操作先绑定 origin/user/company，单次发送；响应丢失、5xx 或不兼容回执保留未知状态，禁止自动重发。创建使用 UUID idempotencyKey，首次提交时间持久化在身份隔离草稿内；官方去重仅保留 7 天，客户端只在首次提交后 6 天内允许重试（留 1 天余量，与 iOS 一致），过期或旧草稿无可信时间禁重发并保留内容。评论使用 clientRequestId。发送前即被拒绝（工作台忙、同身份存在未知回执、超出重试窗口）的命令确定未发出，服务层发布 rejected 回执，UI 回滚“已提交”并保留正文与请求编号；已经发出后的未知结果仍保持 unknown。origin 规则、标识格式、任务状态/优先级枚举（优先级为 critical/high/medium/low）与重试窗口统一来自 `@zcode/shared` 的 Paperclip 协议真相源。

最小闭环：配置 → 登录 → 选公司 → 任务列表/分页/创建 → 详情/评论/状态 → 关联审批/决定 → 历史运行/日志/取消 → 来自当前任务附件清单的受控 contentPath 下载。下载必须重新确认当前任务/附件来源，只接受原生已有 attachments/assets 路径并使用系统另存为。外部 work-product URL 不伪装成可下载产物。

验收：无 Host 可显示配置页；登录取消后重入；401/403/网络错误有中文反馈；切公司/退出后的迟到读取被丢弃；未知写不自动重试；6 天创建重试窗口不被重试刷新；发送前被拒不锁草稿；附件来源及路径校验；局部 service 测试，Renderer 构建、typecheck/lint/architecture，实际 Electron 服务登录与操作验证。真实服务器/真机证据单独记录，不以静态或 fixture 验证替代。

## 2026-10-04 工作台交互重构

采用 Paperclip 的公司导航 / 对话主区 / 任务属性检查器结构；配置与登录只在独立设置对话框内完成，日常工作台不占用服务器配置表单。首页是新任务对话入口，任务详情是同一中心区域的消息流与固定底部回复框。代理列表只读，完整管理功能明确打开服务器网页。

Root 只拥有当前视图、搜索与面板开关；唯一草稿 owner 仍是 usePaperclipDraft，创建与回复各按 identity + issue 隔离。单个视图不同时挂载两份创建输入。新任务、首页和设置均有可见返回入口；窄窗口侧栏与检查器使用独立可关闭、焦点约束的 Dialog，不把三栏纵向堆叠挤出输入框。消息归属仅以服务器作者或已确认 clientRequestId 判断，缺失作者展示中性服务器留言，不虚构 AI 身份或时间。

现有生成代际、7 天去重、未知回执归档、审批 fingerprint、取消确认、附件来源验证保持服务接口不变。确认弹窗与编辑焦点仍会暂停自动刷新。动画只表达面板、消息和按钮变化，prefers-reduced-motion 时关闭位移与动画。验收包含 480 / 960 / 1440 宽度、亮暗主题、配置与返回、消息回复、空列表、错误、未知提交、长文本、键盘焦点与减弱动态效果。
