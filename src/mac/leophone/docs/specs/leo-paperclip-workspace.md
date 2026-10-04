# Mac Paperclip 原生工作区

## 产品规则与边界

- 默认进入服务器工作区，在 React 原生界面完成任务浏览、创建、回复、状态、运行、日志、审批与成果查看。服务器是真实任务状态和执行的唯一所有者；客户端不启动本地 Agent 作为降级路径。
- 旧数据库、历史和旧执行入口仅通过明确的“本地恢复模式”进入，不自动迁移、不把服务端失败转成本地任务。服务器模式启动不等待旧数据库就绪。
- 首次配置明确服务器源（HTTPS；仅 loopback 允许 HTTP），使用独立 Electron 会话登录真正的人类 Better Auth 账号。登录窗口内输入凭据；不允许 agent key 充当用户身份，不把 Cookie/token/password 传入 renderer 或 localStorage。
- 配置保存源地址与名称；公司必须取自登录用户有权访问的服务器列表。每项任务、运行和待核实操作绑定 `serverUrl + companyId + userId`，不能随当前配置重定向。
- 默认全中文文案、状态、错误和帮助；用户内容、模型日志、ID 和第三方名字原样保留。服务器执行目录和 CLI 适配器由服务端管理；Mac 不是远程 worker。

## 所有者和接口

```
React 组件 → usePaperclipWorkspace → PaperclipWorkspaceService → PaperclipTransport
                                     │                         │
                                     │                         └ Electron IPC / 隔离 Cookie 会话 → Paperclip
                                     └ 本地配置、草稿、操作回执（无凭据）
```

- service 单一拥有连接、当前公司、任务快照、加载世代、待核实回执；hook 订阅并发命令，UI 仅有未提交输入/确认框。
- Electron main 负责传输、登录会话、来源和路径验证、下载；不拥有任务业务事实。
- 只通过受控 service public export 跨包访问。UI 不访问 `window.zcode`。

## 上游契约（固定 994d6edcdd4e15d5f9cc5cf8c135ac599104b86a）

| 操作        | 接口                                                                     | 证据                                  |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------- |
| 用户        | GET /api/auth/get-session                                                | ui/src/api/auth.ts                    |
| 公司、Agent | GET /api/companies；GET /api/companies/:id/agents                        | ui/src/api/companies.ts、agents.ts    |
| 创建/列表   | POST/GET /api/companies/:id/issues                                       | ui/src/api/issues.ts                  |
| 回复        | POST /api/issues/:id/comments，body + clientRequestId(UUID)              | validators/issue.ts，routes/issues.ts |
| 状态        | PATCH /api/issues/:id，status                                            | ui/src/api/issues.ts                  |
| 运行        | GET /api/issues/:id/runs（历史）；live-runs（活跃）                      | ui/src/api/activity.ts、heartbeats.ts |
| 日志        | GET /api/heartbeat-runs/:id/log?offset&limitBytes                        | ui/src/api/heartbeats.ts              |
| 取消运行    | POST /api/heartbeat-runs/:id/cancel                                      | 同上                                  |
| 审批        | GET /api/issues/:id/approvals；POST /api/approvals/:id/approve 或 reject | ui/src/api/approvals.ts               |
| 成果        | GET /api/issues/:id/documents、attachments、work-products                | ui/src/api/issues.ts                  |

Issue、heartbeat run、agent 分别建模，绝不互换 ID。运行来自任务关系接口，不以同一 Agent 的所有运行冒充任务历史。

## 时序、重连与不确定性

1. 接收命令时冻结身份与任务 ID，核对当前 human session 与绑定 userId。
2. 写入本地操作回执后才发远端变更；同身份存在未核实回执时禁止第二次写入。
3. 创建使用服务端支持的 `idempotencyKey`；回复使用 `clientRequestId`。收到有效且匹配的回执才确认成功；网络错误、5xx、畸形成功回执均视为“结果待核实”。
4. 不自动重放变更。用户点“核实结果”时，创建/回复可复用同一 key 与原始 body，其他操作只读取目标状态，避免重复审批/取消/状态副作用。
5. 服务端明确拒绝（4xx）才可清除未提交回执；身份失效保留回执并要求重新登录。重启保留回执；切换服务器/公司不更改原回执目标。
6. 配置/公司/任务切换递增世代；晚到旧响应不得覆盖新选择。刷新只产生远端快照，没有 accepted optimistic queue。轮询故障显示离线/会话过期，保留只读快照并停止变更；重连先校验用户再刷新。
7. 桌面这里使用定时快照恢复，不接入旧 desktop-continuous 本地消息流；iOS 有独立服务器客户端，不复用旧远控 replay 协议。

## 验收

- 配置非法源、空公司、未登录、403/404/409/5xx/非 JSON 均显示中文。
- 创建指定服务端 Agent 的任务；同一次操作重试只产生一项；回复重复点击、提交超时、重载回执均不重复。
- 切换服务器/公司/任务时忽略旧响应；更换登录账号不沿用旧身份写入。
- 检查历史/活跃运行合并、日志增量 offset、取消确认、审批内容与决定备注、文档和附件。
- 服务不可达绝不显示假完成，绝不进入本地执行；显式恢复模式可访问旧历史并可返回服务器。
- 服务契约测试覆盖请求路径、身份、回执、恢复和竞争；UI 测试覆盖中文关键路径与恢复入口。Linux 可执行 TypeScript/Node 测试、lint、架构检查；macOS 打包和真实登录/下载人工端到端验证另行记录，未执行不宣称通过。
